export type ReportPeriod = "WEEK" | "MONTH";

/** Views that add up the last complete months, and how many each one covers. */
export const AGGREGATED_MONTHS = { LAST_3_MONTHS: 3, LAST_12_MONTHS: 12 } as const;
export type AggregatedPeriod = keyof typeof AGGREGATED_MONTHS;
/** What the dashboard can show: one Amazon report period, or the last complete months added together. */
export type FunnelPeriod = ReportPeriod | AggregatedPeriod;
export const FUNNEL_PERIODS: readonly FunnelPeriod[] = ["WEEK", "MONTH", "LAST_3_MONTHS", "LAST_12_MONTHS"];
export const isAggregatedPeriod = (period: FunnelPeriod): period is AggregatedPeriod => period in AGGREGATED_MONTHS;

export const FUNNEL_STATUSES = [
  "DROP_IMPRESSIONS_TO_CLICKS",
  "DROP_CLICKS_TO_CART",
  "DROP_CART_TO_PURCHASE",
  "WINNER",
  "NORMAL",
  "LOW_VOLUME",
] as const;
export type FunnelStatus = (typeof FUNNEL_STATUSES)[number];

/** One search term for one ASIN in one report period. Shares are fractions (0–1). */
export interface SearchQueryMetrics {
  queryText: string;
  asin: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  totalQueryVolume: number;
  totalImpressions: number;
  totalClicks: number;
  totalCartAdds: number;
  totalPurchases: number;
  medianPrice: number | null;
  asinMedianPrice: number | null;
  currency: string | null;
  asinImpressions: number;
  asinImpressionShare: number;
  asinClicks: number;
  asinClickShare: number;
  asinCartAdds: number;
  asinCartAddShare: number;
  asinPurchases: number;
  asinPurchaseShare: number;
}

export interface FunnelRatios {
  ctr: number;
  cartRate: number;
  purchaseRate: number;
}

export interface FunnelLeak {
  lostUnits: number;
  impactScore: number;
}

export interface SearchFunnelRow extends SearchQueryMetrics, FunnelRatios, FunnelLeak {
  status: FunnelStatus;
  /** Only on per-ASIN rows: how many search terms were added up. `queryText` is then the term with most impressions. */
  terms?: number;
}

export interface FunnelSummary {
  totalQueries: number;
  dropImpressionsToClicks: number;
  dropClicksToCart: number;
  dropCartToPurchase: number;
  winners: number;
  lostClicks: number;
  lostCartAdds: number;
  lostPurchases: number;
}

export interface SearchFunnelResponse {
  updatedAt: string | null;
  marketplaceId: string;
  period: FunnelPeriod;
  periodStart: string | null;
  periodEnd: string | null;
  asins: Array<{ asin: string; name: string }>;
  summary: FunnelSummary;
  rows: SearchFunnelRow[];
  /** The same data with every search term of an ASIN added up: one row per ASIN, classified with the same rules. */
  asinRows: SearchFunnelRow[];
}

export interface SearchFunnelSyncStatus {
  state: "idle" | "running" | "done" | "failed";
  period: FunnelPeriod | null;
  startedAt: string | null;
  finishedAt: string | null;
  requestedAsins: number;
  rows: number;
  /** ASIN batches Amazon rejected (not brand-owned, data not published yet…). */
  errors: string[];
}
