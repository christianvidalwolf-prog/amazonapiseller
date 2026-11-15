/**
 * Agente del embudo Auto → Frase → Exacta (spec advertising §15). Autónomo: decide y aplica solo.
 * Cada día, por país:
 *  1. Revisión de las subidas con ≥ 14 días: si fracasan (ACoS > 40 %, o ≥ 2 € sin ventas) pausa el
 *     grupo nuevo, quita las negativas que puso en origen y bloquea la búsqueda 60 días; si funcionan
 *     quedan «consolidadas» (las de FRASE vuelven a pasar por el embudo hacia EXACTA).
 *  2. Plan (funnel.ts) y aplicación: grupo nuevo en la campaña destino (FRASE / EXACTA / ASIN) con
 *     los SKUs que vendieron esa búsqueda y tienen stock + Buy Box, keyword o target a la puja de
 *     entrada, y negativa en cada grupo de origen. Activa la campaña FRASE si estaba pausada.
 *  3. Freno: con el ACoS país > 35 % como máximo 5 subidas al día (10 en otro caso).
 *  4. Fase D: suma como candidatas las búsquedas que Brand Analytics (ads:funnel-insights) confirma que
 *     convierten, y pone las negativas que Ads y SQP confirman a la vez (máx. 10 búsquedas/día).
 * Todo queda en el Change Log y en ads_funnel-state_<profileId>.json. ADS_FUNNEL_APPLY=0 → solo plan.
 */
import path from "node:path";
import { AdsApiClient } from "../src/ads/adsClient";
import type { AdvertisedProductReportRow, CampaignReportRow, SearchTermReportRow } from "../src/ads/reportTypes";
import { env } from "../src/config/env";
import type { AdContextSnapshot } from "../src/modules/advertising/adContext";
import { adsContextKey, createFileAdsReportStore } from "../src/modules/advertising/adsReports.store";
import { safeName } from "../src/modules/advertising/campaignPlan";
import { addDays, appendEntry, type ChangeLogEntry, changelogKey } from "../src/modules/advertising/changelog";
import { type Destination, levelOf, normalize, planFunnel, type Promotion } from "../src/modules/advertising/funnel";
import type { Recommendation } from "../src/modules/brand-analytics/funnelInsights";
import { PREFIX } from "./lib/ads-proposals";

const COUNTRIES = (process.env.ADS_PLAN_COUNTRIES ?? "ES,DE,FR,IT").split(",").map((c) => c.trim().toUpperCase());
const APPLY = process.env.ADS_FUNNEL_APPLY !== "0";
const TRIAL_DAYS = 14;
const BLOCK_DAYS = 60;
const FAIL_ACOS = 40;
const FAIL_SPEND_NO_SALES = 2;
const HOT_COUNTRY_ACOS = 35;
const MAX_SKUS = 5;
const INSIGHTS_MAX_AGE_MS = 8 * 86_400_000;
const MAX_CUTS_PER_DAY = 10;
const SQP_EXACT_BID = 0.25;
const SQP_PHRASE_BID = 0.2;
const MT = {
  campaign: "application/vnd.spCampaign.v3+json",
  adGroup: "application/vnd.spAdGroup.v3+json",
  productAd: "application/vnd.spProductAd.v3+json",
  keyword: "application/vnd.spKeyword.v3+json",
  target: "application/vnd.spTargetingClause.v3+json",
  negKeyword: "application/vnd.spNegativeKeyword.v3+json",
  negTarget: "application/vnd.spNegativeTargetingClause.v3+json",
};
const DEST: Record<Destination, { campaign: string; group: string }> = {
  exact: { campaign: "MANUAL | EXACTA", group: "Exacta" },
  phrase: { campaign: "MANUAL | FRASE", group: "Frase" },
  asin: { campaign: "MANUAL | ASIN", group: "ASIN" },
};

interface Trial {
  term: string;
  to: Destination;
  date: string;
  campaignId: string;
  adGroupId: string;
  negatives: Array<{ kind: "keyword" | "target"; id: string }>;
  status: "trial" | "consolidated" | "reverted";
  reviewedAt?: string;
  result?: string;
}
interface FunnelState {
  trials: Trial[];
  /** term → blocked until (YYYY-MM-DD). */
  blocked: Record<string, string>;
}

type Writer = ReturnType<AdsApiClient["writer"]>;
type MultiStatus = { success?: Array<Record<string, unknown> & { index: number }>; error?: Array<{ index: number; errors?: unknown }> };
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const today = new Date().toISOString().slice(0, 10);

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

async function createOne(w: Writer, p: string, mt: string, wrapper: string, item: Record<string, unknown>, idField: string): Promise<string | null> {
  const res = await w.post<Record<string, MultiStatus>>(p, mt, { [wrapper]: [item] });
  const ok = res[wrapper]?.success?.[0];
  if (ok) return String(ok[idField] ?? "");
  const err = JSON.stringify(res[wrapper]?.error?.[0]?.errors ?? "error");
  if (/DUPLICATE|already exists/i.test(err)) return null;
  throw new Error(`Amazon rechazó ${wrapper}: ${err.slice(0, 300)}`);
}

async function main(): Promise<void> {
  const ads = new AdsApiClient(env.adsApi);
  const store = createFileAdsReportStore(path.resolve(process.cwd(), "data", "ads-reports"));
  const profiles = (await ads.getProfiles()).filter((p) => COUNTRIES.includes(p.countryCode));
  console.log(`EMBUDO ${APPLY ? "APLICANDO (autónomo)" : "SOLO PLAN"} · ${profiles.map((p) => p.countryCode).join(", ")}`);
  for (const p of profiles) {
    try {
      await runCountry(ads, store, p.countryCode, String(p.profileId));
    } catch (err) {
      console.log(`${p.countryCode}: ERROR ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
}

async function runCountry(ads: AdsApiClient, store: ReturnType<typeof createFileAdsReportStore>, cc: string, profileId: string): Promise<void> {
  const w = ads.writer(profileId);
  const stateKey = `ads:funnel-state:${profileId}`;
  const state = (await store.readSnapshot<FunnelState>(stateKey)) ?? { trials: [], blocked: {} };
  let changelog = (await store.readSnapshot<ChangeLogEntry[]>(changelogKey(profileId))) ?? [];
  const log = (entityId: string, entityType: string, text: string, oldValue: string | null, newValue: string, reason: string) => {
    const date = new Date().toISOString();
    changelog = appendEntry(changelog, { entityId, date, profileId, country: cc, entityType, text, action: "applied", oldValue, newValue, baselineMetric: "—", reviewDate: addDays(date, TRIAL_DAYS), reason: `Embudo: ${reason}` });
  };

  const campaigns = (await ads.listSponsoredProductsCampaigns(profileId)).filter((c) => c.name.startsWith(PREFIX));
  const names = new Map(campaigns.map((c) => [c.campaignId, c.name]));
  const ids = [...names.keys()];
  const terms = ((await store.load<SearchTermReportRow>(profileId, "searchTerms"))?.rows ?? []).filter((r) => names.has(String(r.campaignId)));

  // 1. Review trials that finished their 14 days.
  for (const t of state.trials.filter((x) => x.status === "trial" && today >= addDays(`${x.date}T00:00:00Z`, TRIAL_DAYS))) {
    const rows = terms.filter((r) => String(r.adGroupId) === t.adGroupId);
    const spend = rows.reduce((a, r) => a + num(r.cost), 0);
    const sales = rows.reduce((a, r) => a + num(r.sales7d), 0);
    const acos = sales > 0 ? (spend / sales) * 100 : null;
    const failed = (acos !== null && acos > FAIL_ACOS) || (sales <= 0 && spend >= FAIL_SPEND_NO_SALES);
    const facts = `${spend.toFixed(2)} € gasto, ${sales.toFixed(2)} € ventas${acos !== null ? `, ACoS ${acos.toFixed(1)} %` : ""}`;
    if (!failed) {
      if (sales <= 0) continue; // too little data yet: keep the trial running
      t.status = "consolidated";
      t.reviewedAt = today;
      t.result = facts;
      console.log(`${cc}: consolidada «${t.term}» (${DEST[t.to].group}) · ${facts}`);
      continue;
    }
    if (APPLY) {
      await w.put("/sp/adGroups", MT.adGroup, { adGroups: [{ adGroupId: t.adGroupId, state: "PAUSED" }] });
      const kw = t.negatives.filter((n) => n.kind === "keyword").map((n) => n.id);
      const tg = t.negatives.filter((n) => n.kind === "target").map((n) => n.id);
      if (kw.length) await w.post("/sp/negativeKeywords/delete", MT.negKeyword, { negativeKeywordIdFilter: { include: kw } });
      if (tg.length) await w.post("/sp/negativeTargets/delete", MT.negTarget, { negativeTargetIdFilter: { include: tg } });
      log(t.adGroupId, "AD_GROUP", t.term, "ENABLED", "PAUSED", `subida fallida tras ${TRIAL_DAYS} días (${facts}); vuelve a su origen`);
    }
    t.status = "reverted";
    t.reviewedAt = today;
    t.result = facts;
    state.blocked[t.term] = addDays(new Date().toISOString(), BLOCK_DAYS);
    console.log(`${cc}: revertida «${t.term}» (${DEST[t.to].group}) · ${facts} · bloqueada ${BLOCK_DAYS} días`);
  }

  // 2. Plan.
  const keywords = await listAll<{ keywordText: string; matchType: string }>(w, "/sp/keywords/list", MT.keyword, "keywords", { campaignIdFilter: { include: ids }, stateFilter: { include: ["ENABLED", "PAUSED"] } });
  const targets = await listAll<{ expression?: Array<{ type: string; value?: string }> }>(w, "/sp/targets/list", MT.target, "targetingClauses", { campaignIdFilter: { include: ids }, stateFilter: { include: ["ENABLED", "PAUSED"] } });
  const live: Record<Destination, Set<string>> = {
    exact: new Set(keywords.filter((k) => k.matchType === "EXACT").map((k) => normalize(k.keywordText))),
    phrase: new Set(keywords.filter((k) => k.matchType === "PHRASE").map((k) => normalize(k.keywordText))),
    asin: new Set(targets.flatMap((t) => (t.expression ?? []).filter((e) => e.type === "ASIN_SAME_AS" && e.value).map((e) => normalize(String(e.value))))),
  };
  const blocked = new Set(Object.entries(state.blocked).filter(([, until]) => until > today).map(([term]) => term));
  for (const t of state.trials.filter((x) => x.status === "trial")) blocked.add(`${t.to}:${t.term}`);
  const report = await store.load<CampaignReportRow>(profileId, "campaigns");
  const pfRows = (report?.rows ?? []).filter((r) => names.has(String(r.campaignId)));
  const cSpend = pfRows.reduce((a, r) => a + num(r.cost), 0);
  const cSales = pfRows.reduce((a, r) => a + num(r.sales7d), 0);
  const countryAcos = cSales > 0 ? (cSpend / cSales) * 100 : null;
  const doneToday = state.trials.filter((t) => t.date === today).length;
  const cap = Math.max(0, (countryAcos !== null && countryAcos > HOT_COUNTRY_ACOS ? 5 : 10) - doneToday);
  // SKUs that sold through each origin ad group, with stock and Buy Box.
  const products = (await store.load<AdvertisedProductReportRow>(profileId, "advertisedProducts"))?.rows ?? [];
  const ctx = await store.readSnapshot<AdContextSnapshot>(adsContextKey(profileId));
  const unavailable = new Set((ctx?.items ?? []).filter((i) => i.alpha === 0).map((i) => i.sku));
  const sellersOf = (adGroupIds: string[]) => {
    const units = new Map<string, number>();
    for (const r of products) {
      if (!adGroupIds.includes(String(r.adGroupId)) || !r.advertisedSku || num(r.unitsSoldSameSku7d) <= 0 || unavailable.has(r.advertisedSku)) continue;
      units.set(r.advertisedSku, (units.get(r.advertisedSku) ?? 0) + num(r.unitsSoldSameSku7d));
    }
    return [...units].sort((a, b) => b[1] - a[1]).slice(0, MAX_SKUS).map(([sku]) => sku);
  };

  const candidates = planFunnel(terms, names, live, blocked, 100)
    .filter((x) => !blocked.has(`${x.to}:${x.term}`))
    .map((x) => ({ x, skus: sellersOf(x.origins.map((o) => o.adGroupId)) }));

  // Fase D: Brand Analytics as second signal — terms that convert for the ASIN (organic included)
  // and are not yet at their level, advertised with that ASIN's SKU. Ads-based candidates go first.
  const insights = await store.readSnapshot<{ generatedAt: string; recommendations: Recommendation[]; cuts: Recommendation[] }>(`ads:sqp-insights:${profileId}`);
  const freshInsights = insights && Date.now() - Date.parse(insights.generatedAt) < INSIGHTS_MAX_AGE_MS ? insights : null;
  const skuOfAsin = new Map<string, string[]>();
  for (const r of products) {
    const asin = String(r.advertisedAsin ?? "").toUpperCase();
    if (!asin || !r.advertisedSku || unavailable.has(r.advertisedSku)) continue;
    skuOfAsin.set(asin, [...new Set([...(skuOfAsin.get(asin) ?? []), r.advertisedSku])]);
  }
  const taken = new Set(candidates.map((c) => `${c.x.to}:${c.x.term}`));
  for (const rec of freshInsights?.recommendations ?? []) {
    if (rec.kind !== "scale" || !rec.to) continue;
    const term = normalize(rec.term);
    const to: Destination = rec.to;
    if (blocked.has(term) || blocked.has(`${to}:${term}`) || taken.has(`${to}:${term}`) || live[to].has(term) || live.exact.has(term)) continue;
    const adsRows = terms.filter((r) => normalize(String(r.searchTerm ?? "")) === term);
    const origins = [...new Map(adsRows.flatMap((r) => {
      const campaignName = names.get(String(r.campaignId)) ?? "";
      const level = levelOf(campaignName);
      return level === "auto" || level === "phrase" ? [[`${r.campaignId}|${r.adGroupId}`, { campaignId: String(r.campaignId), campaignName, adGroupId: String(r.adGroupId), level }] as const] : [];
    })).values()];
    const clicks = adsRows.reduce((a, r) => a + num(r.clicks), 0);
    const spend = adsRows.reduce((a, r) => a + num(r.cost), 0);
    const sales = adsRows.reduce((a, r) => a + num(r.sales7d), 0);
    const cpc = clicks > 0 ? spend / clicks : 0;
    const bid = Math.round(Math.min(1.5, Math.max(0.15, cpc > 0 ? cpc * 1.1 : to === "exact" ? SQP_EXACT_BID : SQP_PHRASE_BID)) * 100) / 100;
    const x: Promotion = { term, to, bid, clicks, orders: adsRows.reduce((a, r) => a + num(r.purchases7d), 0), spend, sales, acos: sales > 0 ? (spend / sales) * 100 : 0, cpc, origins, rule: `SQP ${rec.asin}: ${rec.why}` };
    const skus = rec.asin.split(", ").flatMap((a) => skuOfAsin.get(a) ?? []).slice(0, MAX_SKUS);
    candidates.push({ x, skus });
    taken.add(`${to}:${term}`);
  }
  // Promotions whose selling SKUs have no stock / Buy Box today do not use a slot of the daily cap.
  const waiting = candidates.filter((c) => !c.skus.length).map((c) => c.x.term);
  const chosen = candidates.filter((c) => c.skus.length).slice(0, cap);
  const plan = chosen.map((c) => c.x);
  console.log(`${cc}: ${plan.length} subidas de nivel (máx. ${cap}/día, ACoS país ${countryAcos?.toFixed(1) ?? "—"} %; ${terms.length} búsquedas analizadas)${waiting.length ? ` · ${waiting.length} esperan SKU anunciable (stock, Buy Box o no anunciado en el país): ${waiting.slice(0, 5).join(", ")}` : ""}`);

  // 3. Apply.
  for (const { x, skus } of chosen) {
    const negs = x.origins.map((o) => o.campaignName.replace(`${PREFIX} ${cc} | `, "")).join(", ");
    const line = `→ ${DEST[x.to].group.toUpperCase()} «${x.term}» puja ${x.bid} € · ${x.rule} · negativa en: ${negs}`;
    if (!APPLY) {
      console.log(`   ${line} (solo plan)`);
      continue;
    }
    try {
      const trial = await promote(w, cc, campaigns, x, skus);
      state.trials.push(trial);
      log(trial.adGroupId, "AD_GROUP", x.term, null, `${DEST[x.to].group} a ${x.bid} €`, `${x.rule}; negativa en ${negs}`);
      console.log(`   ${line} · HECHO`);
    } catch (err) {
      console.log(`   ${line} · NO aplicada: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fase D: negatives confirmed by both sources (Ads pays without sales + SQP clicks without purchases).
  let cuts = 0;
  for (const cut of (freshInsights?.cuts ?? []).slice(0, MAX_CUTS_PER_DAY)) {
    const term = normalize(cut.term);
    const groups = [...new Map(terms.filter((r) => normalize(String(r.searchTerm ?? "")) === term && num(r.cost) > 0).flatMap((r) => {
      const level = levelOf(names.get(String(r.campaignId)) ?? "");
      return level === "auto" || level === "phrase" ? [[String(r.adGroupId), String(r.campaignId)] as const] : [];
    })).entries()];
    for (const [adGroupId, campaignId] of groups) {
      if (!APPLY) {
        console.log(`   NEGATIVA «${term}» en grupo ${adGroupId} (solo plan) · ${cut.why}`);
        continue;
      }
      try {
        const id = await createOne(w, "/sp/negativeKeywords", MT.negKeyword, "negativeKeywords", { campaignId, adGroupId, keywordText: term, matchType: "NEGATIVE_EXACT", state: "ENABLED" }, "negativeKeywordId");
        if (id) {
          log(id, "NEGATIVE_EXACT", term, null, `negativa en grupo ${adGroupId}`, `SQP confirma: ${cut.why}`);
          cuts++;
        }
      } catch (err) {
        console.log(`   NEGATIVA «${term}» NO aplicada: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (cuts) console.log(`${cc}: ${cuts} negativas confirmadas por SQP`);
  if (!freshInsights) console.log(`${cc}: sin análisis SQP reciente (ads:funnel-insights); solo señales de Ads`);

  if (APPLY) {
    await store.writeSnapshot(stateKey, state);
    await store.writeSnapshot(changelogKey(profileId), changelog);
  }
  await store.writeSnapshot(`ads:funnel:${profileId}`, { generatedAt: new Date().toISOString(), mode: APPLY ? "apply" : "plan", countryAcos, promotions: plan, trials: state.trials });
}

async function promote(w: Writer, cc: string, campaigns: Array<{ campaignId: string; name: string; state: string }>, x: Promotion, skus: string[]): Promise<Trial> {
  const dest = campaigns.find((c) => c.name === `${PREFIX} ${cc} | ${DEST[x.to].campaign}`);
  if (!dest) throw new Error(`no existe la campaña ${DEST[x.to].campaign}`);
  if (!skus.length) throw new Error("ningún SKU que haya vendido con esta búsqueda tiene stock y Buy Box");
  if (dest.state !== "enabled") {
    await w.put("/sp/campaigns", MT.campaign, { campaigns: [{ campaignId: dest.campaignId, state: "ENABLED" }] });
    dest.state = "enabled";
  }
  const campaignId = dest.campaignId;
  const adGroupId = await createOne(w, "/sp/adGroups", MT.adGroup, "adGroups", { campaignId, name: safeName(`${DEST[x.to].group} | ${x.term}`), state: "ENABLED", defaultBid: x.bid }, "adGroupId");
  if (!adGroupId) throw new Error("ya existe un grupo para esta búsqueda");
  for (const sku of skus) await createOne(w, "/sp/productAds", MT.productAd, "productAds", { campaignId, adGroupId, sku, state: "ENABLED" }, "adId");
  if (x.to === "asin") {
    await createOne(w, "/sp/targets", MT.target, "targetingClauses", { campaignId, adGroupId, expression: [{ type: "ASIN_SAME_AS", value: x.term.toUpperCase() }], expressionType: "MANUAL", bid: x.bid, state: "ENABLED" }, "targetId");
  } else {
    await createOne(w, "/sp/keywords", MT.keyword, "keywords", { campaignId, adGroupId, keywordText: x.term, matchType: x.to === "exact" ? "EXACT" : "PHRASE", bid: x.bid, state: "ENABLED" }, "keywordId");
  }
  // Negatives in every origin ad group, only after the destination exists (no traffic gap).
  const negatives: Trial["negatives"] = [];
  for (const o of x.origins) {
    const id =
      x.to === "asin"
        ? await createOne(w, "/sp/negativeTargets", MT.negTarget, "negativeTargetingClauses", { campaignId: o.campaignId, adGroupId: o.adGroupId, expression: [{ type: "ASIN_SAME_AS", value: x.term.toUpperCase() }], state: "ENABLED" }, "targetId")
        : await createOne(w, "/sp/negativeKeywords", MT.negKeyword, "negativeKeywords", { campaignId: o.campaignId, adGroupId: o.adGroupId, keywordText: x.term, matchType: "NEGATIVE_EXACT", state: "ENABLED" }, "negativeKeywordId");
    if (id) negatives.push({ kind: x.to === "asin" ? "target" : "keyword", id });
  }
  return { term: x.term, to: x.to, date: today, campaignId, adGroupId, negatives, status: "trial" };
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
