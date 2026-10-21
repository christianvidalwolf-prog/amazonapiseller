import type { AdvertisedProductReportRow, SearchTermReportRow } from "../../ads/reportTypes";
import type { AutoTargetingBids, ConvertingTerm } from "./campaignPlan";
import { MAX_CPC, TARGET_ACOS_SHARE } from "./campaignPlan";
import { adGroupBaselines } from "./negatives";
import type { MarginInput } from "./profitability";

/** Inputs of the campaign plan derived from a country's report history (spec advertising §10). */

const ASIN_TERM = /^b0[a-z0-9]{8}$/i;
const MIN_CLICKS_FOR_MULTIPLIER = 15;
const DEAD_SPEND = 5;
/** Pseudo-clicks of the ad group's revenue per click blended into a term's (few-order terms overfit). */
const TERM_PRIOR_CLICKS = 100;
/** A new manual target starts at most at this × the country's average CPC, then rises ≤ 20 % per review. */
const START_BID_VS_AVG_CPC = 2;
const MAX_SKUS_PER_TERM = 5;
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Search terms with at least one order and ACoS within their ad group's break-even become seeds
 * of the manual campaigns, attached to the (up to 5) SKUs of that ad group that sold most own units.
 * Starting bid = smoothed revenue per click × target ACoS, capped at 2 × the country's average CPC.
 */
export function convertingTermSeeds(terms: SearchTermReportRow[], products: AdvertisedProductReportRow[], margins: MarginInput[]): ConvertingTerm[] {
  const { byGroup } = adGroupBaselines(products, margins);
  const unitsByGroup = new Map<string, Map<string, number>>();
  const groupTotals = new Map<string, { clicks: number; sales: number }>();
  let clicksAll = 0;
  let spendAll = 0;
  for (const r of products) {
    const id = String(r.adGroupId ?? "");
    clicksAll += num(r.clicks);
    spendAll += num(r.cost);
    const t = groupTotals.get(id) ?? { clicks: 0, sales: 0 };
    groupTotals.set(id, { clicks: t.clicks + num(r.clicks), sales: t.sales + num(r.sales7d) });
    if (num(r.unitsSoldSameSku7d) <= 0 || !r.advertisedSku) continue;
    const units = unitsByGroup.get(id) ?? new Map<string, number>();
    units.set(r.advertisedSku, (units.get(r.advertisedSku) ?? 0) + num(r.unitsSoldSameSku7d));
    unitsByGroup.set(id, units);
  }
  const sellers = new Map(
    [...unitsByGroup].map(([id, units]) => [id, new Set([...units].sort((a, b) => b[1] - a[1]).slice(0, MAX_SKUS_PER_TERM).map(([sku]) => sku))])
  );
  const groupRpc = (id: string) => {
    const t = groupTotals.get(id);
    return t && t.clicks > 0 ? t.sales / t.clicks : 0;
  };
  const startCap = clicksAll > 0 ? (spendAll / clicksAll) * START_BID_VS_AVG_CPC : MAX_CPC;
  const byTerm = new Map<
    string,
    { text: string; isAsin: boolean; orders: number; spend: number; sales: number; clicks: number; skus: Set<string>; breakEven: number | null; prior: number }
  >();
  for (const r of terms) {
    const raw = String(r.searchTerm ?? "").trim().toLowerCase();
    if (!raw || num(r.purchases7d) <= 0) continue;
    const isAsin = ASIN_TERM.test(raw);
    const text = isAsin ? raw.toUpperCase() : raw;
    const group = String(r.adGroupId ?? "");
    const prev = byTerm.get(text) ?? { text, isAsin, orders: 0, spend: 0, sales: 0, clicks: 0, skus: new Set<string>(), breakEven: null, prior: groupRpc(group) };
    byTerm.set(text, {
      ...prev,
      orders: prev.orders + num(r.purchases7d),
      spend: prev.spend + num(r.cost),
      sales: prev.sales + num(r.sales7d),
      clicks: prev.clicks + num(r.clicks),
      skus: new Set([...prev.skus, ...(sellers.get(group) ?? [])]),
      breakEven: prev.breakEven ?? byGroup.get(group)?.breakEvenAcos ?? null,
    });
  }
  return [...byTerm.values()]
    .filter((t) => t.breakEven !== null && t.sales > 0 && t.clicks > 0 && (t.spend / t.sales) * 100 <= (t.breakEven as number) && t.skus.size > 0)
    .map((t) => ({
      text: t.text,
      isAsin: t.isAsin,
      orders: t.orders,
      acos: round2((t.spend / t.sales) * 100),
      suggestedBid: round2(
        Math.min(
          MAX_CPC,
          startCap,
          ((t.sales + TERM_PRIOR_CLICKS * t.prior) / (t.clicks + TERM_PRIOR_CLICKS)) * (((t.breakEven as number) * TARGET_ACOS_SHARE) / 100)
        )
      ),
      skus: [...t.skus].slice(0, MAX_SKUS_PER_TERM),
    }))
    .sort((a, b) => b.orders - a.orders);
}

/**
 * Bid multiplier per auto targeting group from the country's history: average ACoS / group ACoS,
 * clamped to [0.5, 1.2]; a group that spent ≥ 5 € without sales is paused (0); thin data → default.
 */
export function autoTargetingMultipliers(terms: SearchTermReportRow[]): Partial<AutoTargetingBids> {
  const map: Record<string, keyof AutoTargetingBids> = { "close-match": "close", "loose-match": "loose", substitutes: "substitutes", complements: "complements" };
  const acc = new Map<keyof AutoTargetingBids, { spend: number; sales: number; clicks: number }>();
  let spend = 0;
  let sales = 0;
  for (const r of terms) {
    spend += num(r.cost);
    sales += num(r.sales7d);
    const key = map[String(r.targeting ?? "").toLowerCase()];
    if (!key || r.matchType !== "TARGETING_EXPRESSION_PREDEFINED") continue;
    const a = acc.get(key) ?? { spend: 0, sales: 0, clicks: 0 };
    acc.set(key, { spend: a.spend + num(r.cost), sales: a.sales + num(r.sales7d), clicks: a.clicks + num(r.clicks) });
  }
  const avgAcos = sales > 0 ? spend / sales : null;
  const out: Partial<AutoTargetingBids> = {};
  for (const [key, a] of acc) {
    if (a.sales <= 0) {
      if (a.spend >= DEAD_SPEND) out[key] = 0;
      continue;
    }
    if (a.clicks < MIN_CLICKS_FOR_MULTIPLIER || avgAcos === null) continue;
    out[key] = round2(Math.min(1.2, Math.max(0.5, avgAcos / (a.spend / a.sales))));
  }
  return out;
}
