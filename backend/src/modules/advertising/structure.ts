/**
 * Structure rules of the profit-first campaigns (spec advertising §17), run daily by `ads:daily`:
 *
 *  1. Match-type isolation: every ENABLED exact keyword of an ENABLED campaign gets a NEGATIVE_EXACT
 *     of its text in every "origin" ad group that advertises at least one of the same SKUs and could
 *     match that search — auto ad groups always; phrase ad groups when the search contains one of
 *     their phrases in order; broad ad groups when it contains all words of one of their keywords —
 *     so the exact keyword then serves that
 *     search alone instead of competing with Auto/Frase for it. Negatives created here are remembered;
 *     when the exact keyword is no longer active they are removed so the search is not lost.
 *  2. Auto "substitutes" pruning: the substitutes clause of an auto ad group (product pages of
 *     competitors) is paused once it has ≥ 20 clicks and either no sales or an ACoS above 1.5 × the
 *     ad group's target ACoS. The regulator keeps moving the bids of the clauses that stay.
 */

export const SUBSTITUTE_MIN_CLICKS = 20;
export const SUBSTITUTE_ACOS_FACTOR = 1.5;
export const SUBSTITUTE_EXPRESSION = "ASIN_SUBSTITUTE_RELATED";

export interface StructCampaign {
  campaignId: string;
  name: string;
  state: string;
  targetingType?: string;
}

export interface StructKeyword {
  keywordId: string;
  campaignId: string;
  adGroupId: string;
  keywordText: string;
  matchType: string;
  state: string;
}

export interface StructProductAd {
  campaignId: string;
  adGroupId: string;
  sku: string;
  state: string;
}

export interface StructNegative {
  negativeKeywordId?: string;
  campaignId: string;
  adGroupId: string;
  keywordText: string;
  matchType: string;
  state?: string;
}

/** Negatives this module created (so it only ever removes its own). */
export interface IsolationRecord {
  negativeKeywordId: string;
  campaignId: string;
  adGroupId: string;
  term: string;
  date: string;
}

export interface IsolationPlan {
  create: Array<{ campaignId: string; adGroupId: string; term: string; exactCampaignId: string }>;
  remove: IsolationRecord[];
}

export const normalizeTerm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
const isEnabled = (s: string | undefined) => (s ?? "").toUpperCase() === "ENABLED";

export interface OriginAdGroup {
  campaignId: string;
  auto: boolean;
  phrases: string[];
  broad: string[][];
}

const words = (t: string) => normalizeTerm(t).split(" ").filter(Boolean);

/** Ad groups whose traffic can overlap an exact keyword: auto campaigns and phrase/broad ad groups. */
export function originAdGroups(campaigns: StructCampaign[], keywords: StructKeyword[], productAds: StructProductAd[]): Map<string, OriginAdGroup> {
  const auto = new Set(campaigns.filter((c) => (c.targetingType ?? "").toUpperCase() === "AUTO").map((c) => c.campaignId));
  const origins = new Map<string, OriginAdGroup>();
  const get = (adGroupId: string, campaignId: string) => origins.get(adGroupId) ?? { campaignId, auto: false, phrases: [], broad: [] };
  for (const a of productAds) if (auto.has(a.campaignId)) origins.set(a.adGroupId, { ...get(a.adGroupId, a.campaignId), auto: true });
  for (const k of keywords) {
    if (!isEnabled(k.state)) continue;
    const mt = k.matchType.toUpperCase();
    const o = get(k.adGroupId, k.campaignId);
    if (mt === "PHRASE") origins.set(k.adGroupId, { ...o, phrases: [...o.phrases, normalizeTerm(k.keywordText)] });
    if (mt === "BROAD") origins.set(k.adGroupId, { ...o, broad: [...o.broad, words(k.keywordText)] });
  }
  return origins;
}

/** Whether a search could be served by the ad group (auto always; phrase/broad by their keywords). */
export function canMatch(origin: OriginAdGroup, term: string): boolean {
  if (origin.auto) return true;
  const padded = ` ${normalizeTerm(term)} `;
  if (origin.phrases.some((p) => padded.includes(` ${p} `))) return true;
  const set = new Set(words(term));
  return origin.broad.some((ws) => ws.length > 0 && ws.every((w) => set.has(w)));
}

export function planIsolation(input: {
  campaigns: StructCampaign[];
  keywords: StructKeyword[];
  productAds: StructProductAd[];
  negatives: StructNegative[];
  records: IsolationRecord[];
}): IsolationPlan {
  const enabledCampaigns = new Set(input.campaigns.filter((c) => isEnabled(c.state)).map((c) => c.campaignId));
  const skusByAdGroup = new Map<string, Set<string>>();
  for (const a of input.productAds) {
    if (!isEnabled(a.state)) continue;
    const set = skusByAdGroup.get(a.adGroupId) ?? new Set<string>();
    set.add(a.sku);
    skusByAdGroup.set(a.adGroupId, set);
  }
  const origins = originAdGroups(input.campaigns, input.keywords, input.productAds);
  const exact = input.keywords.filter((k) => k.matchType.toUpperCase() === "EXACT" && isEnabled(k.state) && enabledCampaigns.has(k.campaignId));
  const existing = new Set(
    input.negatives.filter((n) => n.matchType.toUpperCase() === "NEGATIVE_EXACT" && (n.state === undefined || isEnabled(n.state))).map((n) => `${n.adGroupId}|${normalizeTerm(n.keywordText)}`)
  );

  const wanted = new Map<string, { campaignId: string; adGroupId: string; term: string; exactCampaignId: string }>();
  for (const k of exact) {
    const term = normalizeTerm(k.keywordText);
    const exactSkus = skusByAdGroup.get(k.adGroupId);
    if (!exactSkus?.size) continue;
    for (const [adGroupId, origin] of origins) {
      const { campaignId } = origin;
      if (adGroupId === k.adGroupId || !enabledCampaigns.has(campaignId) || !canMatch(origin, term)) continue;
      const originSkus = skusByAdGroup.get(adGroupId);
      if (!originSkus || ![...exactSkus].some((s) => originSkus.has(s))) continue;
      wanted.set(`${adGroupId}|${term}`, { campaignId, adGroupId, term, exactCampaignId: k.campaignId });
    }
  }
  const create = [...wanted.entries()].filter(([key]) => !existing.has(key)).map(([, v]) => v);
  const remove = input.records.filter((r) => !wanted.has(`${r.adGroupId}|${normalizeTerm(r.term)}`));
  return { create, remove };
}

export interface SubstituteTarget {
  targetId: string;
  adGroupId: string;
  expressionType: string;
  bid: number;
  spend: number;
  sales: number;
  orders: number;
  clicks: number;
}

export interface SubstitutePause {
  targetId: string;
  adGroupId: string;
  reason: string;
}

/** Substitutes clauses to pause; `targetAcos` gives each ad group's target (default 22 %). */
export function pruneSubstitutes(targets: SubstituteTarget[], targetAcos: (adGroupId: string) => number): SubstitutePause[] {
  const out: SubstitutePause[] = [];
  for (const t of targets) {
    if (t.expressionType !== SUBSTITUTE_EXPRESSION || t.clicks < SUBSTITUTE_MIN_CLICKS) continue;
    const limit = Math.round(targetAcos(t.adGroupId) * SUBSTITUTE_ACOS_FACTOR * 100) / 100;
    if (t.sales <= 0) {
      out.push({ targetId: t.targetId, adGroupId: t.adGroupId, reason: `productos sustitutos: ${t.clicks} clics y ${t.spend.toFixed(2)} € sin ventas` });
      continue;
    }
    const acos = Math.round((t.spend / t.sales) * 10_000) / 100;
    if (acos > limit) out.push({ targetId: t.targetId, adGroupId: t.adGroupId, reason: `productos sustitutos: ACoS ${acos} % > ${limit} % (1,5 × objetivo) con ${t.clicks} clics` });
  }
  return out;
}

export const TARGET_ACOS_CAP = 22;
export const TARGET_ACOS_FLOOR = 8;
export const BREAKEVEN_SHARE = 0.8;

/**
 * Target ACoS of an ad group (user decision 2026-11-25): min(22 %, 0.8 × break-even ACoS of its
 * products), break-even weighted by each product's ad spend (equal weights without spend), never
 * under 8 %. Products without a known break-even are ignored; none known → 22 %.
 */
export function adGroupTargetAcos(products: Array<{ breakEvenAcos: number | null; spend: number }>): number {
  const known = products.filter((p): p is { breakEvenAcos: number; spend: number } => p.breakEvenAcos !== null && Number.isFinite(p.breakEvenAcos));
  if (!known.length) return TARGET_ACOS_CAP;
  const weight = known.reduce((a, p) => a + p.spend, 0);
  const be = weight > 0 ? known.reduce((a, p) => a + p.breakEvenAcos * p.spend, 0) / weight : known.reduce((a, p) => a + p.breakEvenAcos, 0) / known.length;
  const target = Math.min(TARGET_ACOS_CAP, Math.max(TARGET_ACOS_FLOOR, be * BREAKEVEN_SHARE));
  return Math.round(target * 100) / 100;
}
