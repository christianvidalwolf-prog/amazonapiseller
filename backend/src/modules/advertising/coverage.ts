/**
 * Coverage engine (spec advertising §17.3): products that already sell organically but have no ad
 * in the profit-first campaigns get one in "PF | <CC> | AUTO | Cobertura".
 *
 * Input per marketplace (built by `ads:sync-reports`, step `coverage`): last 30 days of Sales &
 * Traffic by child ASIN plus the active listings (SKU ↔ ASIN). A candidate ASIN needs:
 *  - ≥ 2 units and ≥ 15 sessions in 30 days, unit session percentage ≥ 3 %, Buy Box ≥ 90 %;
 *  - no product ad (any state) of any of its SKUs or of the ASIN in the PF campaigns — a product
 *    paused by the guard, the loss pause or by hand is never re-added here;
 *  - a SKU with stock: FBA SKU with fulfillable units preferred, else an FBM SKU with stock, and at
 *    least 2 weeks of cover at the 30-day sales rate.
 * Best organic sellers first, at most MAX_PER_DAY per country per day. Losers are later paused by
 * the loss pause (`profitPause.ts`) and the stock guard, like any other product.
 */

export const MIN_UNITS = 2;
export const MIN_SESSIONS = 15;
export const MIN_UNIT_SESSION_PCT = 3;
export const MIN_BUY_BOX_PCT = 90;
export const MIN_WEEKS_COVER = 2;
export const MAX_PER_DAY = 25;
export const COVERAGE_BUDGET: Record<string, number> = { ES: 6, DE: 3, FR: 3, IT: 2 };
export const COVERAGE_DEFAULT_BID = 0.18;
export const coverageCampaignName = (prefix: string, cc: string) => `${prefix} ${cc} | AUTO | Cobertura`;

export interface CoverageAsin {
  asin: string;
  sessions: number;
  units: number;
  sales: number;
  unitSessionPct: number;
  buyBoxPct: number;
  skus: Array<{ sku: string; fba: boolean }>;
}

export interface CoverageInput {
  generatedAt: string;
  marketplaceId: string;
  window: { start: string; end: string };
  asins: CoverageAsin[];
}

export interface CoverageCandidate {
  asin: string;
  sku: string;
  stock: number;
  weeksCover: number;
  units: number;
  sales: number;
  unitSessionPct: number;
  reason: string;
}

/** ASINs passing the organic-traction thresholds (applied when the input is built and again here). */
export const hasTraction = (a: CoverageAsin) =>
  a.units >= MIN_UNITS && a.sessions >= MIN_SESSIONS && a.unitSessionPct >= MIN_UNIT_SESSION_PCT && a.buyBoxPct >= MIN_BUY_BOX_PCT;

const round1 = (n: number) => Math.round(n * 10) / 10;

export function selectCoverage(
  input: CoverageInput,
  advertised: { skus: Set<string>; asins: Set<string> },
  stockOf: (sku: string, fba: boolean) => number | null,
  limit = MAX_PER_DAY
): CoverageCandidate[] {
  const out: CoverageCandidate[] = [];
  const ranked = input.asins.filter(hasTraction).sort((a, b) => b.sales - a.sales);
  for (const a of ranked) {
    if (out.length >= limit) break;
    if (advertised.asins.has(a.asin) || a.skus.some((s) => advertised.skus.has(s.sku))) continue;
    const perWeek = a.units / (30 / 7);
    const options = a.skus
      .filter((s) => !s.sku.startsWith("amzn.gr."))
      .map((s) => ({ ...s, stock: stockOf(s.sku, s.fba) }))
      .filter((s): s is { sku: string; fba: boolean; stock: number } => s.stock !== null && s.stock > 0)
      .sort((x, y) => Number(y.fba) - Number(x.fba) || y.stock - x.stock);
    const pick = options.find((s) => s.stock / perWeek >= MIN_WEEKS_COVER);
    if (!pick) continue;
    out.push({
      asin: a.asin,
      sku: pick.sku,
      stock: pick.stock,
      weeksCover: round1(pick.stock / perWeek),
      units: a.units,
      sales: a.sales,
      unitSessionPct: a.unitSessionPct,
      reason: `orgánico 30 d: ${a.units} uds, ${a.sales.toFixed(0)} €, conversión ${a.unitSessionPct} %, Buy Box ${a.buyBoxPct} %, sin anuncio`,
    });
  }
  return out;
}

interface TrafficAsinRow {
  childAsin: string;
  salesByAsin?: { unitsOrdered?: number; orderedProductSales?: { amount?: number } };
  trafficByAsin?: { sessions?: number; unitSessionPercentage?: number; buyBoxPercentage?: number };
}

/** Builds the stored input from the Sales & Traffic report rows and the active listings of the marketplace. */
export function buildCoverageInput(
  marketplaceId: string,
  window: { start: string; end: string },
  traffic: TrafficAsinRow[],
  listings: Array<{ sku: string; asin: string; fba: boolean }>,
  now = new Date()
): CoverageInput {
  const skusByAsin = new Map<string, Array<{ sku: string; fba: boolean }>>();
  for (const l of listings) {
    if (!l.asin || !l.sku) continue;
    skusByAsin.set(l.asin, [...(skusByAsin.get(l.asin) ?? []), { sku: l.sku, fba: l.fba }]);
  }
  const asins = traffic
    .map((r) => ({
      asin: r.childAsin,
      sessions: Number(r.trafficByAsin?.sessions ?? 0),
      units: Number(r.salesByAsin?.unitsOrdered ?? 0),
      sales: Number(r.salesByAsin?.orderedProductSales?.amount ?? 0),
      unitSessionPct: Number(r.trafficByAsin?.unitSessionPercentage ?? 0),
      buyBoxPct: Number(r.trafficByAsin?.buyBoxPercentage ?? 0),
      skus: skusByAsin.get(r.childAsin) ?? [],
    }))
    .filter((a) => hasTraction(a) && a.skus.length > 0);
  return { generatedAt: now.toISOString(), marketplaceId, window, asins };
}
