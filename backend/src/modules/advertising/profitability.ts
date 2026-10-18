import type { AdvertisedProductReportRow } from "../../ads/reportTypes";

/**
 * Proceso 1 — puente de rentabilidad (spec advertising §6).
 *
 * Per SKU: profit before ads (net of VAT) vs. real ad spend, break-even ACoS and
 * profit after ads. Only same-SKU attributed units count toward profit: halo
 * sales of other SKUs have unknown margins, so leaving them out keeps every
 * verdict on the conservative side.
 */

export const DEFAULT_VAT_RATE = 21;
export const MIN_COST_COVERAGE = 0.9;

/** Unit economics of a SKU, from the margins:products snapshot (pricing module). */
export interface MarginInput {
  sku: string;
  /** Consumer price, VAT included (as Amazon EU shows it). */
  price: number | null;
  feesTotal: number | null;
  landedCost: number | null;
  /** Percent, e.g. 21. */
  vatRate: number | null;
}

export type SkuVerdict = "profitable" | "leak" | "idle" | "no_cost";

export interface SkuProfitability {
  sku: string;
  asin: string | null;
  spend: number;
  clicks: number;
  impressions: number;
  /** All 7-day attributed sales, including halo purchases of other SKUs. */
  adSales: number;
  adOrders: number;
  /** Units of this same SKU attributed to its ads. */
  sameSkuUnits: number;
  sameSkuSales: number;
  acos: number | null;
  price: number | null;
  unitProfitBeforeAds: number | null;
  breakEvenAcos: number | null;
  /** sameSkuUnits × unitProfitBeforeAds − spend. */
  profitAfterAds: number | null;
  verdict: SkuVerdict;
  reason?: string;
}

export interface ProfitabilityTotals {
  spend: number;
  adSales: number;
  skus: number;
  skusWithCost: number;
  spendWithCost: number;
  /** spendWithCost / spend; decisions need ≥ MIN_COST_COVERAGE. */
  costCoverage: number;
  coverageOk: boolean;
  profitAfterAds: number;
  leakSkus: number;
  leakSpend: number;
  /** Sum of negative profitAfterAds: money lost to ads on leaking SKUs. */
  leakLoss: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Profit of one unit before advertising: net-of-VAT price − Amazon fees − landed cost. */
export function unitProfitBeforeAds(m: MarginInput | undefined): number | null {
  if (!m || m.price === null || m.feesTotal === null || m.landedCost === null || m.price <= 0) return null;
  const vat = m.vatRate ?? DEFAULT_VAT_RATE;
  return round2(m.price / (1 + vat / 100) - m.feesTotal - m.landedCost);
}

interface SkuAccumulator {
  asin: string | null;
  spend: number;
  clicks: number;
  impressions: number;
  adSales: number;
  adOrders: number;
  sameSkuUnits: number;
  sameSkuSales: number;
}

function aggregateBySku(rows: AdvertisedProductReportRow[]): Map<string, SkuAccumulator> {
  const bySku = new Map<string, SkuAccumulator>();
  for (const row of rows) {
    const sku = String(row.advertisedSku ?? "").trim();
    if (!sku) continue;
    const prev = bySku.get(sku) ?? { asin: row.advertisedAsin ?? null, spend: 0, clicks: 0, impressions: 0, adSales: 0, adOrders: 0, sameSkuUnits: 0, sameSkuSales: 0 };
    bySku.set(sku, {
      asin: prev.asin ?? row.advertisedAsin ?? null,
      spend: prev.spend + num(row.cost),
      clicks: prev.clicks + num(row.clicks),
      impressions: prev.impressions + num(row.impressions),
      adSales: prev.adSales + num(row.sales7d),
      adOrders: prev.adOrders + num(row.purchases7d),
      sameSkuUnits: prev.sameSkuUnits + num(row.unitsSoldSameSku7d),
      sameSkuSales: prev.sameSkuSales + num(row.attributedSalesSameSku7d),
    });
  }
  return bySku;
}

function evaluateSku(sku: string, acc: SkuAccumulator, margin: MarginInput | undefined): SkuProfitability {
  const unitProfit = unitProfitBeforeAds(margin);
  const base = {
    sku,
    asin: acc.asin,
    spend: round2(acc.spend),
    clicks: acc.clicks,
    impressions: acc.impressions,
    adSales: round2(acc.adSales),
    adOrders: acc.adOrders,
    sameSkuUnits: acc.sameSkuUnits,
    sameSkuSales: round2(acc.sameSkuSales),
    acos: acc.adSales > 0 ? round2((acc.spend / acc.adSales) * 100) : null,
    price: margin?.price ?? null,
  };
  if (unitProfit === null) {
    return {
      ...base,
      unitProfitBeforeAds: null,
      breakEvenAcos: null,
      profitAfterAds: null,
      verdict: "no_cost",
      reason: margin ? "Margen incompleto (precio, comisiones o coste)" : "Sin margen en margins:products",
    };
  }
  const profitAfterAds = round2(acc.sameSkuUnits * unitProfit - acc.spend);
  return {
    ...base,
    unitProfitBeforeAds: unitProfit,
    breakEvenAcos: margin?.price ? round2((Math.max(0, unitProfit) / margin.price) * 100) : null,
    profitAfterAds,
    // No spend and no own units: the ad got impressions but cost nothing — neither profitable nor a leak.
    verdict: profitAfterAds < 0 ? "leak" : acc.spend === 0 && acc.sameSkuUnits === 0 ? "idle" : "profitable",
  };
}

export function computeProfitability(
  rows: AdvertisedProductReportRow[],
  margins: MarginInput[]
): { skus: SkuProfitability[]; totals: ProfitabilityTotals } {
  const marginBySku = new Map(margins.map((m) => [m.sku.trim().toUpperCase(), m]));
  const skus = [...aggregateBySku(rows)]
    .map(([sku, acc]) => evaluateSku(sku, acc, marginBySku.get(sku.toUpperCase())))
    .sort((a, b) => (a.profitAfterAds ?? Number.POSITIVE_INFINITY) - (b.profitAfterAds ?? Number.POSITIVE_INFINITY) || b.spend - a.spend);

  const spend = skus.reduce((a, s) => a + s.spend, 0);
  const withCost = skus.filter((s) => s.verdict !== "no_cost");
  const spendWithCost = withCost.reduce((a, s) => a + s.spend, 0);
  const leaks = skus.filter((s) => s.verdict === "leak");
  const costCoverage = spend > 0 ? spendWithCost / spend : 0;
  return {
    skus,
    totals: {
      spend: round2(spend),
      adSales: round2(skus.reduce((a, s) => a + s.adSales, 0)),
      skus: skus.length,
      skusWithCost: withCost.length,
      spendWithCost: round2(spendWithCost),
      costCoverage: Math.round(costCoverage * 1000) / 1000,
      coverageOk: costCoverage >= MIN_COST_COVERAGE,
      profitAfterAds: round2(withCost.reduce((a, s) => a + (s.profitAfterAds ?? 0), 0)),
      leakSkus: leaks.length,
      leakSpend: round2(leaks.reduce((a, s) => a + s.spend, 0)),
      leakLoss: round2(leaks.reduce((a, s) => a + (s.profitAfterAds ?? 0), 0)),
    },
  };
}
