import type { AdvertisedProductReportRow, SearchTermReportRow } from "../../ads/reportTypes";
import { MAX_CPC, TARGET_ACOS_SHARE } from "./bidAdvice";
import { adGroupBaselines } from "./negatives";
import type { MarginInput } from "./profitability";

/**
 * Proceso 3 — cosecha y control de ACoS alto (spec advertising §9, skill rules 4.3 and 5.1).
 *
 * Harvest: a search term from a discovery target (auto / broad / phrase) with ≥ 3 orders,
 * conversion ≥ 1.5 × the account's and ACoS ≤ its break-even graduates to a manual exact
 * keyword (or a manual product target for ASIN searches), and is negated exact in its origin
 * ad group so both never compete (search term isolation).
 * High ACoS: ≥ 5 orders and ACoS > 2 × target. From discovery → negate in origin (retest in
 * exact with a lower bid); already exact → lower its bid gradually. Proposals only.
 */

export const HARVEST_MIN_ORDERS = 3;
export const HARVEST_CVR_FACTOR = 1.5;
export const HIGH_ACOS_MIN_ORDERS = 5;
export const HIGH_ACOS_FACTOR = 2;

const ASIN_TERM = /^b0[a-z0-9]{8}$/i;
const EXACT_ORIGINS = new Set(["EXACT"]);

export type HarvestType = "HARVEST_EXACT" | "HARVEST_PRODUCT_TARGET" | "NEGATIVE_EXACT_ORIGIN" | "BID_DOWN";

export interface HarvestCandidate {
  id: string;
  type: HarvestType;
  rule: "harvest" | "high_acos";
  text: string;
  campaignId: string;
  adGroupId: string;
  originMatchType: string;
  clicks: number;
  orders: number;
  spend: number;
  sales: number;
  acos: number;
  cvr: number;
  breakEvenAcos: number;
  targetAcos: number;
  /** Max sustainable CPC for the term (capped at 1,50 €); starting bid of the graduated keyword. */
  suggestedBid: number;
  reason: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

interface ConvertingTerm {
  campaignId: string;
  adGroupId: string;
  term: string;
  matchType: string;
  clicks: number;
  orders: number;
  spend: number;
  sales: number;
}

function convertingTerms(rows: SearchTermReportRow[]): ConvertingTerm[] {
  const byKey = new Map<string, ConvertingTerm>();
  for (const r of rows) {
    const term = String(r.searchTerm ?? "").trim().toLowerCase();
    if (!term) continue;
    const key = `${r.adGroupId}|${term}`;
    const prev = byKey.get(key) ?? {
      campaignId: String(r.campaignId ?? ""),
      adGroupId: String(r.adGroupId ?? ""),
      term,
      matchType: String(r.matchType ?? ""),
      clicks: 0,
      orders: 0,
      spend: 0,
      sales: 0,
    };
    byKey.set(key, {
      ...prev,
      clicks: prev.clicks + num(r.clicks),
      orders: prev.orders + num(r.purchases7d),
      spend: prev.spend + num(r.cost),
      sales: prev.sales + num(r.sales7d),
    });
  }
  return [...byKey.values()].filter((t) => t.orders > 0 && t.clicks > 0 && t.sales > 0);
}

export function analyzeHarvest(searchTerms: SearchTermReportRow[], products: AdvertisedProductReportRow[], margins: MarginInput[]): HarvestCandidate[] {
  const { byGroup, accountCvr } = adGroupBaselines(products, margins);
  const out: HarvestCandidate[] = [];
  for (const t of convertingTerms(searchTerms)) {
    const breakEvenAcos = byGroup.get(t.adGroupId)?.breakEvenAcos ?? null;
    if (breakEvenAcos === null || breakEvenAcos <= 0) continue;
    const targetAcos = round2(breakEvenAcos * TARGET_ACOS_SHARE);
    const acos = round2((t.spend / t.sales) * 100);
    const cvr = t.orders / t.clicks;
    const suggestedBid = round2(Math.min(MAX_CPC, (t.sales / t.clicks) * (targetAcos / 100)));
    const fromExact = EXACT_ORIGINS.has(t.matchType);
    const isAsin = ASIN_TERM.test(t.term);
    const text = isAsin ? t.term.toUpperCase() : t.term;
    const base = {
      text,
      campaignId: t.campaignId,
      adGroupId: t.adGroupId,
      originMatchType: t.matchType,
      clicks: t.clicks,
      orders: t.orders,
      spend: round2(t.spend),
      sales: round2(t.sales),
      acos,
      cvr: Math.round(cvr * 10_000) / 10_000,
      breakEvenAcos,
      targetAcos,
      suggestedBid,
    };

    if (t.orders >= HIGH_ACOS_MIN_ORDERS && acos > HIGH_ACOS_FACTOR * targetAcos) {
      const type: HarvestType = fromExact ? "BID_DOWN" : "NEGATIVE_EXACT_ORIGIN";
      out.push({
        ...base,
        id: `${t.adGroupId}|${type}|${text}`,
        type,
        rule: "high_acos",
        reason: fromExact
          ? `ACoS ${acos} % > 2 × objetivo (${targetAcos} %) con ${t.orders} pedidos: bajar puja gradualmente hacia ${suggestedBid} €, sin pausar`
          : `ACoS ${acos} % > 2 × objetivo (${targetAcos} %) con ${t.orders} pedidos: negativa exacta en origen y probar en Exacta a ${suggestedBid} €`,
      });
      continue;
    }
    if (!fromExact && t.orders >= HARVEST_MIN_ORDERS && cvr >= HARVEST_CVR_FACTOR * accountCvr && acos <= breakEvenAcos) {
      const type: HarvestType = isAsin ? "HARVEST_PRODUCT_TARGET" : "HARVEST_EXACT";
      out.push({
        ...base,
        id: `${t.adGroupId}|${type}|${text}`,
        type,
        rule: "harvest",
        reason: `${t.orders} pedidos, conversión ${(cvr * 100).toFixed(1)} % (≥ 1,5 × ${(accountCvr * 100).toFixed(1)} %), ACoS ${acos} % ≤ equilibrio ${breakEvenAcos} %: graduar a ${isAsin ? "targeting manual de producto" : "Exacta"} con puja inicial ${suggestedBid} € y negativa exacta en el grupo de origen`,
      });
    }
  }
  return out.sort((a, b) => b.sales - a.sales);
}
