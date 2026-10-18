/**
 * Daily control of the profit-first Amazon Ads campaigns (spec advertising §11-12). Run by the 9:00
 * launchd agent after `ads:sync-reports` (run_ads_daily.sh). Per country:
 *  1. The user's decisions in informes-ads/decisiones.txt (approved ones executed in Amazon).
 *  2. Guard: pause ads whose product has no stock or lost the Buy Box; re-enable the ones it paused.
 *  3. Regulator (from day 14 after launch, at most every 7 days): keep the country's 30-day ACoS
 *     under 25 % (aim 22 %) by moving keyword / target bids within the guardrails.
 *  4. The daily report (informes-ads/AAAA-MM-DD.pdf, plus .html) and, 33 days after launch, the
 *     30-day report. Every change goes to the Change Log. ADS_DAILY_APPLY=0 only reports.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AdsApiClient } from "../src/ads/adsClient";
import type { CampaignReportRow, SearchTermReportRow } from "../src/ads/reportTypes";
import type { AdsProfile } from "../src/ads/types";
import { env } from "../src/config/env";
import { isFbaSku, spApiContextSources } from "../src/modules/advertising/adContext.sync";
import { type AdsReportStore, createFileAdsReportStore, createSupabaseAdsReportStore } from "../src/modules/advertising/adsReports.store";
import { addDays, appendEntry, type ChangeLogEntry, changelogKey, maturingEntities, REVIEW_AFTER_DAYS } from "../src/modules/advertising/changelog";
import { type CountryDaily, type HistoryPoint, judgedAcos, renderDailyReport } from "../src/modules/advertising/dailyReport";
import { type Availability, type GuardState, guardAds } from "../src/modules/advertising/guard";
import { type BidEntity, regulate } from "../src/modules/advertising/regulator";
import { SpApiClient } from "../src/spapi/client";
import { DECISIONS_FILE, loadProposals, PREFIX, pfStore, processDecisions, REPORTS_DIR, readDecisionsFile, writeProcessed } from "./lib/ads-proposals";
import { loadStockSnapshot } from "./lib/listing-archive-store";

const COUNTRIES = (process.env.ADS_PLAN_COUNTRIES ?? "ES,DE,FR,IT").split(",").map((c) => c.trim().toUpperCase());
const APPLY = process.env.ADS_DAILY_APPLY !== "0";
const LAUNCH = process.env.ADS_LAUNCH_DATE ?? "2026-10-18";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** 30-day ACoS of every campaign before the launch (old structure), for the comparison. */
const BASELINE_ACOS: Record<string, number> = { ES: 26.9, DE: 25.2, FR: 29.2, IT: 20.8 };
const MT = {
  productAd: "application/vnd.spProductAd.v3+json",
  keyword: "application/vnd.spKeyword.v3+json",
  target: "application/vnd.spTargetingClause.v3+json",
};
const guardKey = (profileId: string) => `ads:guard:${profileId}`;
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const today = new Date().toISOString().slice(0, 10);
const dataDir = path.resolve(process.cwd(), "data");
const historyFile = path.join(dataDir, "ads-daily-history.jsonl");

type Writer = ReturnType<AdsApiClient["writer"]>;
type Decisions = ReturnType<typeof readDecisionsFile>["parsed"]["decisions"];

async function listAll<T>(w: Writer, p: string, mt: string, wrapper: string, filter: Record<string, unknown>): Promise<T[]> {
  const out: T[] = [];
  let nextToken: string | undefined;
  do {
    const res = await w.post<Record<string, unknown> & { nextToken?: string }>(p, mt, { ...filter, maxResults: 1000, ...(nextToken ? { nextToken } : {}) });
    out.push(...((res[wrapper] as T[]) ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

function money(rows: CampaignReportRow[]) {
  const spend = rows.reduce((a, r) => a + num(r.cost), 0);
  const sales = rows.reduce((a, r) => a + num(r.sales7d), 0);
  return { spend: Math.round(spend * 100) / 100, sales: Math.round(sales * 100) / 100, acos: sales > 0 ? Math.round((spend / sales) * 10_000) / 100 : null };
}

async function availabilityOf(profile: AdsProfile, productAds: Array<{ sku: string; asin?: string }>, fbmStock: Map<string, number>) {
  const sp = spApiContextSources(new SpApiClient({ credentials: env.spApi }), profile.accountInfo.marketplaceStringId, env.sellerId);
  const skus = [...new Set(productAds.map((a) => a.sku))];
  const fba = await sp.fulfillable(skus.filter(isFbaSku));
  const asinBySku = new Map(productAds.filter((a) => a.asin).map((a) => [a.sku, a.asin as string]));
  const buyBox = new Map<string, boolean | null>();
  for (const asin of new Set(asinBySku.values())) buyBox.set(asin, await sp.buyBox(asin).catch(() => null));
  const out = new Map<string, Availability>();
  for (const sku of skus) {
    const stock = isFbaSku(sku) ? (fba.get(sku) ?? 0) : (fbmStock.get(sku) ?? null);
    if (stock === null) continue; // FBM SKU missing from STOCK AMZ: unknown, leave as is
    const bb = buyBox.get(asinBySku.get(sku) ?? "") ?? null;
    if (stock <= 0) out.set(sku, { available: false, reason: isFbaSku(sku) ? "sin stock FBA" : "sin stock en almacén" });
    else if (bb === false) out.set(sku, { available: false, reason: "sin Buy Box" });
    else out.set(sku, { available: true });
  }
  return out;
}

async function controlCountry(profile: AdsProfile, ads: AdsApiClient, store: AdsReportStore, fbmStock: Map<string, number>, decisions: Decisions) {
  const cc = profile.countryCode;
  const profileId = String(profile.profileId);
  const w = ads.writer(profileId);
  const campaigns = (await ads.listSponsoredProductsCampaigns(profileId)).filter((c) => c.name.startsWith(PREFIX));
  const ids = campaigns.map((c) => c.campaignId);
  const daily: CountryDaily = {
    country: cc,
    window: null,
    transition: true,
    all: { spend: 0, sales: 0, acos: null },
    pf: { spend: 0, sales: 0, acos: null },
    baselineAcos: BASELINE_ACOS[cc] ?? null,
    budget: campaigns.filter((c) => c.state === "enabled").reduce((a, c) => a + c.dailyBudget, 0),
    guard: { paused: [], resumed: [] },
    regulator: { status: "learning", until: addDays(`${LAUNCH}T00:00:00Z`, REVIEW_AFTER_DAYS), changes: [] },
    deadCampaigns: [],
    decisions: [],
    pending: [],
    errors: [],
  };
  if (!ids.length) return { ...daily, errors: [`Sin campañas ${PREFIX} en ${cc}`] };
  const pf = pfStore(store, ids);

  // 1. The user's decisions
  let proposals = await loadProposals(pf, cc);
  const outcomes = await processDecisions(ads, pf, profile, campaigns, proposals, decisions, APPLY);
  daily.decisions = outcomes.map(({ code, verdict, result }) => ({ code, verdict, result }));
  if (outcomes.length) proposals = await loadProposals(pf, cc);

  let changelog = (await store.readSnapshot<ChangeLogEntry[]>(changelogKey(profileId))) ?? [];
  const record = (entityId: string, entityType: string, text: string, oldValue: string | null, newValue: string, reason: string, baseline: string) => {
    const date = new Date().toISOString();
    changelog = appendEntry(changelog, { entityId, date, profileId, country: cc, entityType, text, action: "applied", oldValue, newValue, baselineMetric: baseline, reviewDate: addDays(date, REVIEW_AFTER_DAYS), reason });
  };

  // 2. Guard
  const productAds = await listAll<{ adId: string; sku: string; asin?: string; state: string }>(w, "/sp/productAds/list", MT.productAd, "productAds", {
    campaignIdFilter: { include: ids },
    stateFilter: { include: ["ENABLED", "PAUSED"] },
  });
  const state = (await store.readSnapshot<GuardState>(guardKey(profileId))) ?? { paused: {} };
  const decision = guardAds(productAds, await availabilityOf(profile, productAds, fbmStock), state, today);
  const changes = [...decision.pause.map((p) => ({ adId: p.adId, state: "PAUSED" })), ...decision.resume.map((r) => ({ adId: r.adId, state: "ENABLED" }))];
  if (APPLY && changes.length) await w.put("/sp/productAds", MT.productAd, { productAds: changes });
  for (const p of decision.pause) record(p.adId, "PRODUCT_AD", p.sku, "ENABLED", "PAUSED", `Guardia: ${p.reason}`, "—");
  for (const r of decision.resume) record(r.adId, "PRODUCT_AD", r.sku, "PAUSED", "ENABLED", "Guardia: vuelve a estar disponible", "—");
  // One line per product even if it is advertised in several ad groups.
  daily.guard = { paused: [...new Map(decision.pause.map((p) => [p.sku, p])).values()].map(({ sku, reason }) => ({ sku, reason })), resumed: [...new Set(decision.resume.map((r) => r.sku))] };
  let nextState: GuardState = decision.next;

  // 3. Regulator
  const learningUntil = addDays(`${LAUNCH}T00:00:00Z`, REVIEW_AFTER_DAYS);
  const due = today >= learningUntil && (!state.lastRegulatorRun || today >= addDays(`${state.lastRegulatorRun}T00:00:00Z`, 7));
  if (today >= learningUntil && !due) daily.regulator = { status: "waiting", changes: [] };
  if (due) {
    const terms = (await pf.load<SearchTermReportRow>(profileId, "searchTerms"))?.rows ?? [];
    const keywords = await listAll<{ keywordId: string; keywordText: string; bid?: number }>(w, "/sp/keywords/list", MT.keyword, "keywords", { campaignIdFilter: { include: ids }, stateFilter: { include: ["ENABLED"] } });
    const targets = await listAll<{ targetId: string; bid?: number; expression?: Array<{ type: string; value?: string }> }>(w, "/sp/targets/list", MT.target, "targetingClauses", {
      campaignIdFilter: { include: ids },
      stateFilter: { include: ["ENABLED"] },
    });
    const stats = new Map<string, { spend: number; sales: number; orders: number; clicks: number }>();
    for (const r of terms) {
      const id = String(r.keywordId ?? "");
      const s = stats.get(id) ?? { spend: 0, sales: 0, orders: 0, clicks: 0 };
      stats.set(id, { spend: s.spend + num(r.cost), sales: s.sales + num(r.sales7d), orders: s.orders + num(r.purchases7d), clicks: s.clicks + num(r.clicks) });
    }
    const zero = { spend: 0, sales: 0, orders: 0, clicks: 0 };
    const autoName: Record<string, string> = { QUERY_HIGH_REL_MATCHES: "segmentación cercana", QUERY_BROAD_REL_MATCHES: "segmentación amplia", ASIN_SUBSTITUTE_RELATED: "productos sustitutos", ASIN_ACCESSORY_RELATED: "productos complementarios" };
    const entities: BidEntity[] = [
      ...keywords.map((k) => ({ id: k.keywordId, kind: "keyword" as const, label: `la keyword «${k.keywordText}»`, bid: num(k.bid), ...(stats.get(k.keywordId) ?? zero) })),
      ...targets.map((t) => {
        const e = t.expression?.[0];
        const label = e?.type === "ASIN_SAME_AS" ? `el ASIN ${e.value}` : `la ${autoName[e?.type ?? ""] ?? "segmentación"}`;
        return { id: t.targetId, kind: "target" as const, label, bid: num(t.bid), ...(stats.get(t.targetId) ?? zero) };
      }),
    ];
    const result = regulate(entities, new Set(maturingEntities(changelog).keys()));
    const kw = result.changes.filter((c) => c.kind === "keyword").map((c) => ({ keywordId: c.id, bid: c.newBid }));
    const tg = result.changes.filter((c) => c.kind === "target").map((c) => ({ targetId: c.id, bid: c.newBid }));
    if (APPLY && kw.length) await w.put("/sp/keywords", MT.keyword, { keywords: kw });
    if (APPLY && tg.length) await w.put("/sp/targets", MT.target, { targetingClauses: tg });
    for (const c of result.changes) record(c.id, c.kind === "keyword" ? "KEYWORD" : "TARGET", c.label, `${c.oldBid} €`, `${c.newBid} €`, `Regulador: ${c.reason}`, `ACoS país ${result.countryAcos} %`);
    daily.regulator = { status: "ran", countryAcos: result.countryAcos, mode: result.mode, changes: result.changes };
    nextState = { ...nextState, lastRegulatorRun: today };
  }
  if (APPLY) {
    await store.writeSnapshot(guardKey(profileId), nextState);
    await store.writeSnapshot(changelogKey(profileId), changelog);
  }

  // 4. Facts for the report
  const report = await store.load<CampaignReportRow>(profileId, "campaigns");
  daily.window = report ? { start: report.startDate, end: report.endDate } : null;
  daily.transition = !report || report.startDate < LAUNCH;
  daily.all = money(report?.rows ?? []);
  const pfRows = (report?.rows ?? []).filter((r) => ids.includes(String(r.campaignId)));
  daily.pf = money(pfRows);
  if (report && !daily.transition) {
    const withImpressions = new Set(pfRows.filter((r) => num(r.impressions) > 0).map((r) => String(r.campaignId)));
    daily.deadCampaigns = campaigns.filter((c) => c.state === "enabled" && !withImpressions.has(c.campaignId)).map((c) => c.name);
  }
  const profitability = await proposals.advertising.getProfitability(cc);
  if (profitability.totals && profitability.totals.spend > 0) {
    const scored = profitability.skus.filter((s) => s.profitAfterAds !== null);
    daily.profit = {
      profitAfterAds: profitability.totals.profitAfterAds,
      leakSkus: profitability.totals.leakSkus,
      leakLoss: profitability.totals.leakLoss,
      winners: scored.filter((s) => (s.profitAfterAds ?? 0) > 0).sort((a, b) => (b.profitAfterAds ?? 0) - (a.profitAfterAds ?? 0)).slice(0, 5).map((s) => ({ sku: s.sku, profit: s.profitAfterAds ?? 0 })),
      leaks: scored.filter((s) => (s.profitAfterAds ?? 0) < 0).slice(0, 5).map((s) => ({ sku: s.sku, profit: s.profitAfterAds ?? 0 })),
    };
  }
  daily.pending = proposals.pending.map((p) => ({ code: p.code, action: p.action, text: p.proposal.text, reason: p.proposal.reason }));
  return daily;
}

function readHistory(): HistoryPoint[] {
  if (!fs.existsSync(historyFile)) return [];
  return fs
    .readFileSync(historyFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as HistoryPoint)
    .filter((h) => h.acos);
}

/** HTML → PDF with the installed Chrome (no extra dependency). Returns the PDF path, or null. */
function toPdf(htmlPath: string, pdfPath: string): string | null {
  try {
    execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`], { stdio: "ignore", timeout: 120_000 });
    return fs.existsSync(pdfPath) ? pdfPath : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const ads = new AdsApiClient(env.adsApi);
  const store =
    process.env.ADS_STORE !== "file" && env.supabase.url && env.supabase.serviceRoleKey
      ? createSupabaseAdsReportStore(env.supabase.url, env.supabase.serviceRoleKey)
      : createFileAdsReportStore(path.join(dataDir, "ads-reports"));
  const stockAmz = await loadStockSnapshot().catch(() => null);
  const fbmStock = new Map((stockAmz?.items ?? []).map((i) => [String(i.sku), Number(i.quantity) || 0]));
  const profiles = (await ads.getProfiles()).filter((p) => COUNTRIES.includes(p.countryCode)).sort((a, b) => COUNTRIES.indexOf(a.countryCode) - COUNTRIES.indexOf(b.countryCode));
  const { text, parsed } = readDecisionsFile();

  const countries: CountryDaily[] = [];
  const outcomes: Array<{ code: string; result: string; line: number }> = [];
  for (const p of profiles) {
    try {
      const daily = await controlCountry(p, ads, store, fbmStock, parsed.decisions);
      countries.push(daily);
      for (const d of daily.decisions) {
        const line = parsed.decisions.find((x) => x.code === d.code)?.line;
        if (line) outcomes.push({ code: d.code, result: d.result, line });
      }
    } catch (err) {
      countries.push({
        country: p.countryCode,
        window: null,
        transition: true,
        all: { spend: 0, sales: 0, acos: null },
        pf: { spend: 0, sales: 0, acos: null },
        baselineAcos: BASELINE_ACOS[p.countryCode] ?? null,
        budget: 0,
        guard: { paused: [], resumed: [] },
        regulator: { status: "learning", changes: [] },
        deadCampaigns: [],
        decisions: [],
        pending: [],
        errors: [err instanceof Error ? err.message : String(err)],
      });
      process.exitCode = 1;
    }
  }
  if (APPLY && outcomes.length) writeProcessed(text, outcomes.map((o) => ({ ...o, verdict: "approved" as const })), today);

  // History: one point per day (re-runs overwrite the day).
  fs.mkdirSync(dataDir, { recursive: true });
  const history = readHistory().filter((h) => h.date !== today);
  history.push({ date: today, acos: Object.fromEntries(countries.map((c) => [c.country, judgedAcos(c)])) });
  fs.writeFileSync(historyFile, `${history.map((h) => JSON.stringify(h)).join("\n")}\n`);

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const html = renderDailyReport(today, countries, history, path.relative(path.resolve(process.cwd(), ".."), DECISIONS_FILE), parsed.invalid.map((i) => i.text), !APPLY);
  const htmlPath = path.join(REPORTS_DIR, `${today}.html`);
  fs.writeFileSync(htmlPath, html);
  const pdf = toPdf(htmlPath, path.join(REPORTS_DIR, `${today}.pdf`));
  console.log(`INFORME ${pdf ?? htmlPath}`);
  for (const c of countries) console.log(`${c.country}: ACoS ${judgedAcos(c) ?? "—"} %${c.transition ? " (PF)" : ""} · pausas ${c.guard.paused.length} · pujas ${c.regulator.changes.length} · pendientes ${c.pending.length} · errores ${c.errors.length}`);
  if (countries.some((c) => (judgedAcos(c) ?? 0) > 25)) console.log("ALERTA_ACOS");

  if (today >= addDays(`${LAUNCH}T00:00:00Z`, 33) && !fs.existsSync(path.join(REPORTS_DIR, "informe-30-dias.pdf"))) {
    const html30 = renderDailyReport(`Informe 30 días (${LAUNCH} → ${today})`, countries, history, "informes-ads/decisiones.txt", [], !APPLY);
    const p30 = path.join(REPORTS_DIR, "informe-30-dias.html");
    fs.writeFileSync(p30, html30);
    toPdf(p30, path.join(REPORTS_DIR, "informe-30-dias.pdf"));
    console.log("INFORME_30_DIAS_LISTO");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
