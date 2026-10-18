import type { AdsMetricRow } from "../../ads/reportTypes";
import type { AdMetrics, AdvertisingSummaryMetrics } from "../../ads/types";

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Spec §2 formulas over raw report rows (ACoS/CTR in %, ROAS as ratio). */
export function toAdMetrics(rows: AdsMetricRow[]): AdMetrics {
  const impressions = rows.reduce((a, r) => a + num(r.impressions), 0);
  const clicks = rows.reduce((a, r) => a + num(r.clicks), 0);
  const cost = rows.reduce((a, r) => a + num(r.cost), 0);
  const sales = rows.reduce((a, r) => a + num(r.sales7d), 0);
  const orders = rows.reduce((a, r) => a + num(r.purchases7d), 0);
  return {
    impressions,
    clicks,
    cost: round2(cost),
    sales: round2(sales),
    orders,
    cpc: clicks > 0 ? round2(cost / clicks) : 0,
    ctr: impressions > 0 ? round2((clicks / impressions) * 100) : 0,
    acos: sales > 0 ? round2((cost / sales) * 100) : 0,
    roas: cost > 0 ? round2(sales / cost) : 0,
  };
}

export function toSummaryMetrics(m: AdMetrics, totalStoreSales: number | null): AdvertisingSummaryMetrics {
  return {
    spend: m.cost,
    attributedSales: m.sales,
    totalStoreSales,
    clicks: m.clicks,
    impressions: m.impressions,
    orders: m.orders,
    cpc: m.cpc,
    ctr: m.ctr,
    acos: m.acos,
    roas: m.roas,
    tacos: totalStoreSales && totalStoreSales > 0 ? round2((m.cost / totalStoreSales) * 100) : null,
  };
}

/** Spec §5: metrics are conclusive only if present and not all zero. */
export function isConclusive(metrics: AdvertisingSummaryMetrics | null): metrics is AdvertisingSummaryMetrics {
  return metrics !== null && (metrics.impressions > 0 || metrics.clicks > 0 || metrics.spend > 0);
}

const SALES_CHANNEL_BY_COUNTRY: Record<string, string> = {
  ES: "Amazon.es",
  DE: "Amazon.de",
  FR: "Amazon.fr",
  IT: "Amazon.it",
  UK: "Amazon.co.uk",
  NL: "Amazon.nl",
  PL: "Amazon.pl",
  SE: "Amazon.se",
  BE: "Amazon.com.be",
  TR: "Amazon.com.tr",
};

/** Sales channel (as in the orders report) of an Ads profile's country, for TACoS. */
export const salesChannelFor = (countryCode?: string) => (countryCode ? SALES_CHANNEL_BY_COUNTRY[countryCode] : undefined);
