import type { FunnelLeak, FunnelRatios, FunnelStatus, FunnelSummary, SearchFunnelRow, SearchQueryMetrics } from "./searchFunnel.types";

/** Thresholds of the leak rules. Counts are per ASIN and search term within one report period. */
export const FUNNEL_THRESHOLDS = {
  minImpressions: 500,
  clickShareVsImpressionShare: 0.5,
  minClicks: 30,
  minCartRate: 0.035,
  minCartAdds: 10,
  minPurchaseRate: 0.2,
  winnerPurchaseShare: 0.2,
  winnerPurchaseRate: 0.4,
} as const;

const ratio = (numerator: number, denominator: number): number => (denominator > 0 ? numerator / denominator : 0);
const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

export function funnelRatios(m: SearchQueryMetrics): FunnelRatios {
  return {
    ctr: ratio(m.asinClicks, m.asinImpressions),
    cartRate: ratio(m.asinCartAdds, m.asinClicks),
    purchaseRate: ratio(m.asinPurchases, m.asinCartAdds),
  };
}

/**
 * The earliest leak in the funnel wins: a term that already loses the click in
 * the search results is reported there even if the later stages also look weak.
 */
export function classifyFunnel(m: SearchQueryMetrics): FunnelStatus {
  const t = FUNNEL_THRESHOLDS;
  const { cartRate, purchaseRate } = funnelRatios(m);

  if (m.asinImpressions >= t.minImpressions && m.asinClickShare < m.asinImpressionShare * t.clickShareVsImpressionShare) {
    return "DROP_IMPRESSIONS_TO_CLICKS";
  }
  if (m.asinClicks >= t.minClicks && cartRate < t.minCartRate) return "DROP_CLICKS_TO_CART";
  if (m.asinCartAdds >= t.minCartAdds && purchaseRate < t.minPurchaseRate) return "DROP_CART_TO_PURCHASE";
  if (m.asinPurchaseShare >= t.winnerPurchaseShare && purchaseRate >= t.winnerPurchaseRate) return "WINNER";

  const enoughSample =
    m.asinImpressions >= t.minImpressions || m.asinClicks >= t.minClicks || m.asinCartAdds >= t.minCartAdds;
  return enoughSample ? "NORMAL" : "LOW_VOLUME";
}

/**
 * What the leak costs. `lostUnits` is in the unit of the stage that fails
 * (clicks, cart adds or purchases) and assumes the ASIN had kept its share of
 * the previous stage. `impactScore` puts every status on one scale — the
 * search volume behind the share that was lost (or, for winners, held) — so
 * rows of different stages can be ranked together.
 */
export function funnelLeak(m: SearchQueryMetrics, status: FunnelStatus): FunnelLeak {
  const t = FUNNEL_THRESHOLDS;
  const lost = (expected: number, actual: number) => Math.max(0, round(expected - actual, 1));
  const volumeBehind = (shareGap: number) => Math.max(0, Math.round(m.totalQueryVolume * shareGap));

  switch (status) {
    case "DROP_IMPRESSIONS_TO_CLICKS":
      return {
        lostUnits: lost(m.asinImpressionShare * m.totalClicks, m.asinClicks),
        impactScore: volumeBehind(m.asinImpressionShare - m.asinClickShare),
      };
    case "DROP_CLICKS_TO_CART": {
      const marketCartRate = Math.max(ratio(m.totalCartAdds, m.totalClicks), t.minCartRate);
      return {
        lostUnits: lost(m.asinClicks * marketCartRate, m.asinCartAdds),
        impactScore: volumeBehind(m.asinClickShare - m.asinCartAddShare),
      };
    }
    case "DROP_CART_TO_PURCHASE": {
      const marketPurchaseRate = Math.max(ratio(m.totalPurchases, m.totalCartAdds), t.minPurchaseRate);
      return {
        lostUnits: lost(m.asinCartAdds * marketPurchaseRate, m.asinPurchases),
        impactScore: volumeBehind(m.asinCartAddShare - m.asinPurchaseShare),
      };
    }
    case "WINNER":
      return { lostUnits: 0, impactScore: volumeBehind(m.asinPurchaseShare) };
    default:
      return { lostUnits: 0, impactScore: 0 };
  }
}

export function toFunnelRow(m: SearchQueryMetrics): SearchFunnelRow {
  const status = classifyFunnel(m);
  const ratios = funnelRatios(m);
  return {
    ...m,
    ctr: round(ratios.ctr, 4),
    cartRate: round(ratios.cartRate, 4),
    purchaseRate: round(ratios.purchaseRate, 4),
    status,
    ...funnelLeak(m, status),
  };
}

export function summarizeFunnel(rows: SearchFunnelRow[]): FunnelSummary {
  const summary: FunnelSummary = {
    totalQueries: rows.length,
    dropImpressionsToClicks: 0,
    dropClicksToCart: 0,
    dropCartToPurchase: 0,
    winners: 0,
    lostClicks: 0,
    lostCartAdds: 0,
    lostPurchases: 0,
  };
  for (const row of rows) {
    if (row.status === "DROP_IMPRESSIONS_TO_CLICKS") {
      summary.dropImpressionsToClicks += 1;
      summary.lostClicks += row.lostUnits;
    } else if (row.status === "DROP_CLICKS_TO_CART") {
      summary.dropClicksToCart += 1;
      summary.lostCartAdds += row.lostUnits;
    } else if (row.status === "DROP_CART_TO_PURCHASE") {
      summary.dropCartToPurchase += 1;
      summary.lostPurchases += row.lostUnits;
    } else if (row.status === "WINNER") {
      summary.winners += 1;
    }
  }
  summary.lostClicks = Math.round(summary.lostClicks);
  summary.lostCartAdds = Math.round(summary.lostCartAdds);
  summary.lostPurchases = Math.round(summary.lostPurchases);
  return summary;
}

/** Highest impact first; ties broken by search volume so the list is stable. */
export function sortByImpact(rows: SearchFunnelRow[]): SearchFunnelRow[] {
  return [...rows].sort((a, b) => b.impactScore - a.impactScore || b.totalQueryVolume - a.totalQueryVolume);
}
