/**
 * Daily control of the profit-first Amazon Ads campaigns (spec advertising §11). Run by the 9:00
 * launchd agent after `ads:sync-reports` (run_ads_daily.sh). Per country:
 *  1. Guard: pause ads whose product has no stock or lost the Buy Box; re-enable the ones it paused.
 *  2. Regulator (from day 14 after launch, at most every 7 days): keep the country's 30-day ACoS
 *     under 25 % (aim 22 %) by moving keyword / target bids within the guardrails.
 *  3. Daily summary (markdown + history) and, 33 days after launch, the 30-day report.
 * Every change goes to the Change Log. ADS_DAILY_APPLY=0 only reports.
 */
import fs from "node:fs";
import path from "node:path";
import { AdsApiClient } from "../src/ads/adsClient";
import type { CampaignReportRow, SearchTermReportRow } from "../src/ads/reportTypes";
import type { AdsProfile } from "../src/ads/types";
import { env } from "../src/config/env";
import { isFbaSku, spApiContextSources } from "../src/modules/advertising/adContext.sync";
import { type AdsReportStore, createFileAdsReportStore, createSupabaseAdsReportStore } from "../src/modules/advertising/adsReports.store";
import { addDays, appendEntry, type ChangeLogEntry, changelogKey, maturingEntities, REVIEW_AFTER_DAYS } from "../src/modules/advertising/changelog";
import { type Availability, type GuardState, guardAds } from "../src/modules/advertising/guard";
import { type BidEntity, LIMIT_ACOS, regulate, TARGET_ACOS } from "../src/modules/advertising/regulator";
import { SpApiClient } from "../src/spapi/client";
import { loadStockSnapshot } from "./lib/listing-archive-store";

const COUNTRIES = (process.env.ADS_PLAN_COUNTRIES ?? "ES,DE,FR,IT").split(",").map((c) => c.trim().toUpperCase());
const APPLY = process.env.ADS_DAILY_APPLY !== "0";
const LAUNCH = process.env.ADS_LAUNCH_DATE ?? "2026-10-18";
const PREFIX = "PF |";
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

type Writer = ReturnType<AdsApiClient["writer"]>;

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

function acosOf(rows: CampaignReportRow[]) {
  const spend = rows.reduce((a, r) => a + num(r.cost), 0);
  const sales = rows.reduce((a, r) => a + num(r.sales7d), 0);
  return { spend: Math.round(spend * 100) / 100, sales: Math.round(sales * 100) / 100, acos: sales > 0 ? Math.round((spend / sales) * 10_000) / 100 : null };
}

const light = (acos: number | null) => (acos === null ? "⚪" : acos > LIMIT_ACOS ? "🔴" : acos > TARGET_ACOS ? "🟠" : "🟢");

async function controlCountry(profile: AdsProfile, ads: AdsApiClient, store: AdsReportStore, fbmStock: Map<string, number>) {
  const cc = profile.countryCode;
  const profileId = String(profile.profileId);
  const w = ads.writer(profileId);
  const lines: string[] = [];
  const log: ChangeLogEntry[] = (await store.readSnapshot<ChangeLogEntry[]>(changelogKey(profileId))) ?? [];
  let changelog = log;
  const record = (entityId: string, entityType: string, text: string, oldValue: string | null, newValue: string, reason: string, baseline: string) => {
    const date = new Date().toISOString();
    changelog = appendEntry(changelog, { entityId, date, profileId, country: cc, entityType, text, action: "applied", oldValue, newValue, baselineMetric: baseline, reviewDate: addDays(date, REVIEW_AFTER_DAYS), reason });
  };

  const campaigns = (await ads.listSponsoredProductsCampaigns(profileId)).filter((c) => c.name.startsWith(PREFIX));
  const ids = campaigns.map((c) => c.campaignId);
  if (!ids.length) return { cc, lines: [`## ${cc}\n_Sin campañas ${PREFIX}._`], metrics: null };

  // 1. Guard
  const productAds = await listAll<{ adId: string; sku: string; asin?: string; state: string }>(w, "/sp/productAds/list", MT.productAd, "productAds", {
    campaignIdFilter: { include: ids },
    stateFilter: { include: ["ENABLED", "PAUSED"] },
  });
  const sp = spApiContextSources(new SpApiClient({ credentials: env.spApi }), profile.accountInfo.marketplaceStringId, env.sellerId);
  const skus = [...new Set(productAds.map((a) => a.sku))];
  const fba = await sp.fulfillable(skus.filter(isFbaSku));
  const asinBySku = new Map(productAds.filter((a) => a.asin).map((a) => [a.sku, a.asin as string]));
  const buyBox = new Map<string, boolean | null>();
  for (const asin of new Set(asinBySku.values())) buyBox.set(asin, await sp.buyBox(asin).catch(() => null));
  const availability = new Map<string, Availability>();
  for (const sku of skus) {
    const stock = isFbaSku(sku) ? (fba.get(sku) ?? 0) : (fbmStock.get(sku) ?? null);
    const bb = buyBox.get(asinBySku.get(sku) ?? "") ?? null;
    if (stock === null) continue; // FBM SKU missing from STOCK AMZ: unknown, leave as is
    if (stock <= 0) availability.set(sku, { available: false, reason: isFbaSku(sku) ? "sin stock FBA" : "sin stock en almacén" });
    else if (bb === false) availability.set(sku, { available: false, reason: "sin Buy Box" });
    else availability.set(sku, { available: true });
  }
  const state = (await store.readSnapshot<GuardState>(guardKey(profileId))) ?? { paused: {} };
  const decision = guardAds(productAds, availability, state, today);
  const changes = [...decision.pause.map((p) => ({ adId: p.adId, state: "PAUSED" })), ...decision.resume.map((r) => ({ adId: r.adId, state: "ENABLED" }))];
  if (APPLY && changes.length) await w.put("/sp/productAds", MT.productAd, { productAds: changes });
  for (const p of decision.pause) record(p.adId, "PRODUCT_AD", p.sku, "ENABLED", "PAUSED", `Guardia: ${p.reason}`, "—");
  for (const r of decision.resume) record(r.adId, "PRODUCT_AD", r.sku, "PAUSED", "ENABLED", "Guardia: vuelve a estar disponible", "—");
  let nextState: GuardState = decision.next;

  // 2. Regulator
  const terms = (await store.load<SearchTermReportRow>(profileId, "searchTerms"))?.rows.filter((r) => ids.includes(String(r.campaignId))) ?? [];
  const regulatorDue = today >= addDays(`${LAUNCH}T00:00:00Z`, REVIEW_AFTER_DAYS) && (!state.lastRegulatorRun || today >= addDays(`${state.lastRegulatorRun}T00:00:00Z`, 7));
  let regulatorLine = `Regulador: en aprendizaje hasta ${addDays(`${LAUNCH}T00:00:00Z`, REVIEW_AFTER_DAYS)}.`;
  if (regulatorDue) {
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
    const entities: BidEntity[] = [
      ...keywords.map((k) => ({ id: k.keywordId, kind: "keyword" as const, label: `"${k.keywordText}"`, bid: num(k.bid), ...(stats.get(k.keywordId) ?? zero) })),
      ...targets.map((t) => ({ id: t.targetId, kind: "target" as const, label: `${t.expression?.[0]?.type ?? "target"} ${t.expression?.[0]?.value ?? ""}`.trim(), bid: num(t.bid), ...(stats.get(t.targetId) ?? zero) })),
    ];
    const result = regulate(entities, new Set(maturingEntities(changelog).keys()));
    const kw = result.changes.filter((c) => c.kind === "keyword").map((c) => ({ keywordId: c.id, bid: c.newBid }));
    const tg = result.changes.filter((c) => c.kind === "target").map((c) => ({ targetId: c.id, bid: c.newBid }));
    if (APPLY && kw.length) await w.put("/sp/keywords", MT.keyword, { keywords: kw });
    if (APPLY && tg.length) await w.put("/sp/targets", MT.target, { targetingClauses: tg });
    for (const c of result.changes) record(c.id, c.kind === "keyword" ? "KEYWORD" : "TARGET", c.label, `${c.oldBid} €`, `${c.newBid} €`, `Regulador: ${c.reason}`, `ACoS país ${result.countryAcos} %`);
    regulatorLine = `Regulador: ACoS PF ${result.countryAcos ?? "—"} % → modo ${result.mode}, ${result.changes.length} pujas ${APPLY ? "cambiadas" : "propuestas"}.`;
    nextState = { ...nextState, lastRegulatorRun: today };
  }

  if (APPLY) {
    await store.writeSnapshot(guardKey(profileId), nextState);
    await store.writeSnapshot(changelogKey(profileId), changelog);
  }

  // 3. Summary
  const report = await store.load<CampaignReportRow>(profileId, "campaigns");
  const all = acosOf(report?.rows ?? []);
  const pf = acosOf((report?.rows ?? []).filter((r) => ids.includes(String(r.campaignId))));
  const budget = campaigns.filter((c) => c.state === "enabled").reduce((a, c) => a + c.dailyBudget, 0);
  // While the 30-day window still starts before the launch it mixes in the old campaigns: judge the PF ones only.
  const transition = !report || report.startDate < LAUNCH;
  const judged = transition ? pf.acos : all.acos;
  lines.push(
    `## ${cc} ${light(judged)} ${judged === null ? "sin datos todavía" : `${judged} %`}${transition ? " (solo PF: ventana de transición)" : ""}`,
    `Ventana ${report?.startDate ?? "—"} → ${report?.endDate ?? "—"} · ACoS país ${all.acos ?? "—"} % (gasto ${all.spend} €, ventas ${all.sales} €) · solo PF ${pf.acos ?? "—"} % (gasto ${pf.spend} €) · antes del lanzamiento ${BASELINE_ACOS[cc] ?? "—"} % · presupuesto activo ${budget.toFixed(2)} €/día`,
    `Guardia: ${decision.pause.length} anuncios pausados (${decision.pause.map((p) => `${p.sku}: ${p.reason}`).join(", ") || "—"}), ${decision.resume.length} reactivados.`,
    regulatorLine
  );
  return { cc, lines, metrics: { all, pf, budget } };
}

function thirtyDayReportDue(): boolean {
  const file = path.join(dataDir, "ads-informe-30-dias.md");
  return today >= addDays(`${LAUNCH}T00:00:00Z`, 33) && !fs.existsSync(file);
}

async function main(): Promise<void> {
  const ads = new AdsApiClient(env.adsApi);
  const store =
    process.env.ADS_STORE !== "file" && env.supabase.url && env.supabase.serviceRoleKey
      ? createSupabaseAdsReportStore(env.supabase.url, env.supabase.serviceRoleKey)
      : createFileAdsReportStore(path.join(dataDir, "ads-reports"));
  const stockAmz = await loadStockSnapshot().catch(() => null);
  const fbmStock = new Map((stockAmz?.items ?? []).map((i) => [String(i.sku), Number(i.quantity) || 0]));
  const profiles = (await ads.getProfiles()).filter((p) => COUNTRIES.includes(p.countryCode));

  const sections = [`# Control diario Amazon Ads · ${today}`, `_${APPLY ? "Cambios aplicados" : "Solo informe (ADS_DAILY_APPLY=0)"} · objetivo ACoS país 30 d ≤ ${LIMIT_ACOS} % (apunta a ${TARGET_ACOS} %)_`];
  const history: Record<string, unknown> = { date: today };
  for (const p of profiles) {
    try {
      const res = await controlCountry(p, ads, store, fbmStock);
      sections.push(...res.lines);
      history[res.cc] = res.metrics;
    } catch (err) {
      sections.push(`## ${p.countryCode}\n**ERROR:** ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const md = sections.join("\n\n");
  fs.writeFileSync(path.join(dataDir, `ads-daily-${today}.md`), md);
  fs.appendFileSync(path.join(dataDir, "ads-daily-history.jsonl"), `${JSON.stringify(history)}\n`);
  console.log(md);
  if (thirtyDayReportDue()) {
    const historyLines = fs.readFileSync(path.join(dataDir, "ads-daily-history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const trend = historyLines.map((h) => `| ${h.date} | ${["ES", "DE", "FR", "IT"].map((cc) => (h[cc]?.all?.acos ?? "—")).join(" | ")} |`);
    const report = [
      `# Informe 30 días · campañas profit-first (lanzadas ${LAUNCH})`,
      ...sections.slice(2),
      "## Evolución del ACoS de 30 días por país",
      "| Fecha | ES | DE | FR | IT |",
      "| --- | --- | --- | --- | --- |",
      ...trend,
      `Antes del lanzamiento: ${Object.entries(BASELINE_ACOS).map(([cc, a]) => `${cc} ${a} %`).join(" · ")}. Detalle por producto y propuestas: \`npm run ads:audit\`.`,
    ].join("\n\n");
    fs.writeFileSync(path.join(dataDir, "ads-informe-30-dias.md"), report);
    console.log("INFORME_30_DIAS_LISTO");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
