/**
 * Daily structure and coverage steps of `ads:daily` (spec advertising §17): match-type isolation,
 * auto "substitutes" pruning and the coverage campaign. Pure rules live in
 * src/modules/advertising/structure.ts and coverage.ts; this file only reads/writes Amazon Ads,
 * the state snapshots and the Change Log.
 */
import type { SearchTermReportRow } from "../../src/ads/reportTypes";
import type { AdCampaign } from "../../src/ads/types";
import type { AdsReportStore } from "../../src/modules/advertising/adsReports.store";
import { adsCoverageKey } from "../../src/modules/advertising/adsReports.store";
import { COVERAGE_BUDGET, COVERAGE_DEFAULT_BID, type CoverageInput, coverageCampaignName, selectCoverage } from "../../src/modules/advertising/coverage";
import type { CountryDaily } from "../../src/modules/advertising/dailyReport";
import { type IsolationRecord, planIsolation, pruneSubstitutes } from "../../src/modules/advertising/structure";

export const MT = {
  campaign: "application/vnd.spCampaign.v3+json",
  adGroup: "application/vnd.spAdGroup.v3+json",
  productAd: "application/vnd.spProductAd.v3+json",
  keyword: "application/vnd.spKeyword.v3+json",
  negKeyword: "application/vnd.spNegativeKeyword.v3+json",
  target: "application/vnd.spTargetingClause.v3+json",
} as const;

export interface Writer {
  post<T>(path: string, mediaType: string, body: unknown): Promise<T>;
  put<T>(path: string, mediaType: string, body: unknown): Promise<T>;
}
export type Recorder = (entityId: string, entityType: string, text: string, oldValue: string | null, newValue: string, reason: string, baseline: string) => void;
export type StructureAction = NonNullable<CountryDaily["structure"]>[number];
export interface ProductAdRow {
  adId: string;
  campaignId: string;
  adGroupId: string;
  sku: string;
  asin?: string;
  state: string;
}
type MultiStatus = { success?: Array<Record<string, unknown> & { index: number }>; error?: Array<{ index: number; errors?: unknown }> };

const isolationKey = (profileId: string) => `ads:isolation:${profileId}`;
const coverageStateKey = (profileId: string) => `ads:coverage:${profileId}`;
const BATCH = 100;
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export async function listAll<T>(w: Writer, p: string, mt: string, wrapper: string, filter: Record<string, unknown>): Promise<T[]> {
  const out: T[] = [];
  let nextToken: string | undefined;
  do {
    const res = await w.post<Record<string, unknown> & { nextToken?: string }>(p, mt, { ...filter, maxResults: 1000, ...(nextToken ? { nextToken } : {}) });
    out.push(...((res[wrapper] as T[]) ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

/** Creates items in batches; returns the id of each item (by input index) or its error text. */
async function createMany(w: Writer, path: string, mt: string, wrapper: string, items: Array<Record<string, unknown>>, idField: string): Promise<Array<{ id?: string; error?: string }>> {
  const out: Array<{ id?: string; error?: string }> = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const res = await w.post<Record<string, MultiStatus>>(path, mt, { [wrapper]: chunk });
    const result: Array<{ id?: string; error?: string }> = chunk.map(() => ({ error: "sin respuesta" }));
    for (const s of res[wrapper]?.success ?? []) result[s.index] = { id: String(s[idField] ?? "") };
    for (const e of res[wrapper]?.error ?? []) result[e.index] = { error: JSON.stringify(e.errors ?? "error").slice(0, 200) };
    out.push(...result);
  }
  return out;
}

/** Stats per keyword/target id from the 30-day search-term report. */
export function statsById(terms: SearchTermReportRow[]) {
  const stats = new Map<string, { spend: number; sales: number; orders: number; clicks: number }>();
  for (const r of terms) {
    const id = String(r.keywordId ?? "");
    const s = stats.get(id) ?? { spend: 0, sales: 0, orders: 0, clicks: 0 };
    stats.set(id, { spend: s.spend + num(r.cost), sales: s.sales + num(r.sales7d), orders: s.orders + num(r.purchases7d), clicks: s.clicks + num(r.clicks) });
  }
  return stats;
}

interface StructureContext {
  w: Writer;
  profileId: string;
  campaigns: AdCampaign[];
  productAds: ProductAdRow[];
  terms: SearchTermReportRow[];
  targetOf: (adGroupId: string) => number;
  store: AdsReportStore;
  apply: boolean;
  record: Recorder;
  today: string;
}

/** Match-type isolation (create / remove our own negatives). */
export async function runIsolation(ctx: StructureContext): Promise<StructureAction[]> {
  const ids = ctx.campaigns.map((c) => c.campaignId);
  const keywords = await listAll<{ keywordId: string; campaignId: string; adGroupId: string; keywordText: string; matchType: string; state: string }>(ctx.w, "/sp/keywords/list", MT.keyword, "keywords", {
    campaignIdFilter: { include: ids },
    stateFilter: { include: ["ENABLED"] },
  });
  const negatives = await listAll<{ negativeKeywordId: string; campaignId: string; adGroupId: string; keywordText: string; matchType: string; state: string }>(ctx.w, "/sp/negativeKeywords/list", MT.negKeyword, "negativeKeywords", {
    campaignIdFilter: { include: ids },
    stateFilter: { include: ["ENABLED"] },
  });
  const records = (await ctx.store.readSnapshot<IsolationRecord[]>(isolationKey(ctx.profileId))) ?? [];
  const plan = planIsolation({
    campaigns: ctx.campaigns.map((c) => ({ campaignId: c.campaignId, name: c.name, state: c.state, targetingType: c.targetingType })),
    keywords: keywords.map((k) => ({ ...k, campaignId: String(k.campaignId), adGroupId: String(k.adGroupId) })),
    productAds: ctx.productAds.map((a) => ({ campaignId: String(a.campaignId), adGroupId: String(a.adGroupId), sku: a.sku, state: a.state })),
    negatives: negatives.map((n) => ({ ...n, campaignId: String(n.campaignId), adGroupId: String(n.adGroupId) })),
    records,
  });
  const name = new Map(ctx.campaigns.map((c) => [c.campaignId, c.name]));
  const actions: StructureAction[] = [];
  let next = records.filter((r) => !plan.remove.includes(r));

  if (plan.remove.length && ctx.apply) await ctx.w.post("/sp/negativeKeywords/delete", MT.negKeyword, { negativeKeywordIdFilter: { include: plan.remove.map((r) => r.negativeKeywordId) } });
  for (const r of plan.remove) {
    ctx.record(r.negativeKeywordId, "NEGATIVE_KEYWORD", r.term, "NEGATIVE_EXACT", "eliminada", "Aislamiento: la exacta ya no está activa, la búsqueda vuelve a su origen", "—");
    actions.push({ type: "Quitar negativa", what: `«${r.term}» en ${name.get(r.campaignId) ?? r.campaignId}`, why: "La keyword exacta ya no está activa: el término vuelve a servirse desde Auto/Frase." });
  }

  if (plan.create.length) {
    const results = ctx.apply
      ? await createMany(ctx.w, "/sp/negativeKeywords", MT.negKeyword, "negativeKeywords", plan.create.map((c) => ({ campaignId: c.campaignId, adGroupId: c.adGroupId, keywordText: c.term, matchType: "NEGATIVE_EXACT", state: "ENABLED" })), "negativeKeywordId")
      : plan.create.map((): { id?: string; error?: string } => ({ id: "simulacro" }));
    plan.create.forEach((c, i) => {
      const r = results[i];
      if (!r?.id) {
        actions.push({ type: "Negativa", what: `«${c.term}» en ${name.get(c.campaignId) ?? c.campaignId}`, why: `Amazon la rechazó: ${r?.error ?? "error"}` });
        return;
      }
      next = [...next, { negativeKeywordId: r.id, campaignId: c.campaignId, adGroupId: c.adGroupId, term: c.term, date: ctx.today }];
      ctx.record(r.id, "NEGATIVE_KEYWORD", c.term, null, "NEGATIVE_EXACT", `Aislamiento: la exacta de ${name.get(c.exactCampaignId) ?? c.exactCampaignId} sirve esta búsqueda`, "—");
      actions.push({ type: "Negativa", what: `«${c.term}» en ${name.get(c.campaignId) ?? c.campaignId}`, why: `Ya tiene keyword exacta en ${name.get(c.exactCampaignId) ?? "otra campaña"}: así no compiten por la misma búsqueda.` });
    });
  }
  if (ctx.apply) await ctx.store.writeSnapshot(isolationKey(ctx.profileId), next);
  return actions;
}

/** Pauses losing "substitutes" clauses of the auto ad groups. */
export async function runSubstitutes(ctx: StructureContext): Promise<StructureAction[]> {
  const auto = ctx.campaigns.filter((c) => c.targetingType === "auto" && c.state === "enabled").map((c) => c.campaignId);
  if (!auto.length) return [];
  const targets = await listAll<{ targetId: string; adGroupId: string; campaignId: string; bid?: number; expression?: Array<{ type: string }> }>(ctx.w, "/sp/targets/list", MT.target, "targetingClauses", {
    campaignIdFilter: { include: auto },
    stateFilter: { include: ["ENABLED"] },
  });
  const stats = statsById(ctx.terms);
  const zero = { spend: 0, sales: 0, orders: 0, clicks: 0 };
  const pauses = pruneSubstitutes(
    targets.map((t) => ({ targetId: String(t.targetId), adGroupId: String(t.adGroupId), expressionType: t.expression?.[0]?.type ?? "", bid: num(t.bid), ...(stats.get(String(t.targetId)) ?? zero) })),
    ctx.targetOf
  );
  if (!pauses.length) return [];
  if (ctx.apply) await ctx.w.put("/sp/targets", MT.target, { targetingClauses: pauses.map((p) => ({ targetId: p.targetId, state: "PAUSED" })) });
  const campaignOf = new Map(targets.map((t) => [String(t.targetId), String(t.campaignId)]));
  const name = new Map(ctx.campaigns.map((c) => [c.campaignId, c.name]));
  return pauses.map((p) => {
    ctx.record(p.targetId, "TARGET", "productos sustitutos", "ENABLED", "PAUSED", `Estructura: ${p.reason}`, "—");
    return { type: "Pausa" as const, what: `Productos sustitutos de ${name.get(campaignOf.get(p.targetId) ?? "") ?? "Auto"}`, why: `${p.reason}. Las fichas de la competencia no convierten aquí; siguen la segmentación cercana, amplia y complementarios.` };
  });
}

interface CoverageState {
  campaignId?: string;
  adGroupId?: string;
  added: Array<{ sku: string; asin: string; adId: string; date: string }>;
}

/** Adds organic sellers without an ad to "PF | <CC> | AUTO | Cobertura" (creating it if needed). */
export async function runCoverage(
  ctx: StructureContext & { cc: string; prefix: string; stockOf: (skus: Array<{ sku: string; fba: boolean }>) => Promise<(sku: string, fba: boolean) => number | null> }
): Promise<StructureAction[]> {
  const input = await ctx.store.readSnapshot<CoverageInput>(adsCoverageKey(ctx.profileId));
  if (!input?.asins.length) return [];
  const advertised = { skus: new Set(ctx.productAds.map((a) => a.sku)), asins: new Set(ctx.productAds.map((a) => a.asin).filter((a): a is string => Boolean(a))) };
  const stockOf = await ctx.stockOf(input.asins.flatMap((a) => a.skus));
  const picks = selectCoverage(input, advertised, stockOf);
  if (!picks.length) return [];

  const state = (await ctx.store.readSnapshot<CoverageState>(coverageStateKey(ctx.profileId))) ?? { added: [] };
  const name = coverageCampaignName(ctx.prefix, ctx.cc);
  const actions: StructureAction[] = [];
  let campaignId = ctx.campaigns.find((c) => c.name === name)?.campaignId ?? state.campaignId;
  let adGroupId = state.adGroupId;
  if (!ctx.apply) {
    return picks.map((p) => ({ type: "Nuevo anuncio" as const, what: `${p.sku} (${p.asin}) en ${name}`, why: `Simulacro · ${p.reason}` }));
  }
  if (!campaignId) {
    const budget = COVERAGE_BUDGET[ctx.cc] ?? 2;
    const [res] = await createMany(ctx.w, "/sp/campaigns", MT.campaign, "campaigns", [{ name, targetingType: "AUTO", state: "ENABLED", dynamicBidding: { strategy: "LEGACY_FOR_SALES" }, budget: { budgetType: "DAILY", budget }, startDate: ctx.today }], "campaignId");
    if (!res?.id) throw new Error(`No se pudo crear ${name}: ${res?.error}`);
    campaignId = res.id;
    ctx.record(campaignId, "CAMPAIGN", name, null, `ENABLED ${budget} €/día`, "Cobertura: productos con venta orgánica sin anuncio", "—");
    actions.push({ type: "Nuevo anuncio", what: `Campaña ${name} (${budget} €/día)`, why: "Creada para anunciar productos que ya venden en orgánico y no tenían anuncio." });
  }
  if (!adGroupId) {
    const groups = await listAll<{ adGroupId: string; name: string }>(ctx.w, "/sp/adGroups/list", MT.adGroup, "adGroups", { campaignIdFilter: { include: [campaignId] } });
    adGroupId = groups.find((g) => g.name === "Cobertura")?.adGroupId;
    if (!adGroupId) {
      const [res] = await createMany(ctx.w, "/sp/adGroups", MT.adGroup, "adGroups", [{ campaignId, name: "Cobertura", state: "ENABLED", defaultBid: COVERAGE_DEFAULT_BID }], "adGroupId");
      if (!res?.id) throw new Error(`No se pudo crear el grupo Cobertura: ${res?.error}`);
      adGroupId = res.id;
    }
  }
  const results = await createMany(ctx.w, "/sp/productAds", MT.productAd, "productAds", picks.map((p) => ({ campaignId, adGroupId, sku: p.sku, state: "ENABLED" })), "adId");
  const added = [...state.added];
  picks.forEach((p, i) => {
    const r = results[i];
    if (!r?.id) {
      actions.push({ type: "Nuevo anuncio", what: `${p.sku} (${p.asin})`, why: `Amazon lo rechazó: ${r?.error ?? "error"}` });
      return;
    }
    added.push({ sku: p.sku, asin: p.asin, adId: r.id, date: ctx.today });
    ctx.record(r.id, "PRODUCT_AD", p.sku, null, "ENABLED", `Cobertura: ${p.reason}`, `${p.units} uds orgánicas 30 d`);
    actions.push({ type: "Nuevo anuncio", what: `${p.sku} (${p.asin}) en ${name}`, why: `${p.reason}; stock para ${p.weeksCover} semanas.` });
  });
  await ctx.store.writeSnapshot(coverageStateKey(ctx.profileId), { campaignId, adGroupId, added });
  return actions;
}
