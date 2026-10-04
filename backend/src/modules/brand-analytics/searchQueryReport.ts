import type { ReportPeriod, SearchQueryMetrics } from "./searchFunnel.types";

export const SEARCH_QUERY_PERFORMANCE_REPORT = "GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT";

/** Amazon caps the `asin` report option at 200 characters of space-separated ASINs. */
const MAX_ASIN_OPTION_LENGTH = 200;

const DAY_MS = 24 * 3600 * 1000;
const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * The report only accepts whole periods: weeks run Sunday to Saturday and
 * months are calendar months. `periodsBack` 0 is the last complete one.
 */
export function reportPeriodRange(
  period: ReportPeriod,
  now: Date = new Date(),
  periodsBack = 0
): { periodStart: string; periodEnd: string } {
  if (period === "MONTH") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1 - periodsBack, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    return { periodStart: isoDate(start), periodEnd: isoDate(end) };
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // getUTCDay(): 0 = Sunday … 6 = Saturday. The last Saturday strictly before today closes the week.
  const daysSinceSaturday = (new Date(today).getUTCDay() + 1) % 7 || 7;
  const end = today - daysSinceSaturday * DAY_MS - periodsBack * 7 * DAY_MS;
  return { periodStart: isoDate(new Date(end - 6 * DAY_MS)), periodEnd: isoDate(new Date(end)) };
}

export function chunkAsinsForReport(asins: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const asin of asins) {
    const added = (current.length ? 1 : 0) + asin.length;
    if (current.length && length + added > MAX_ASIN_OPTION_LENGTH) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    length += (current.length ? 1 : 0) + asin.length;
    current.push(asin);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === "object" ? (value as Json) : {});
const num = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const price = (value: unknown): { amount: number | null; currency: string | null } => {
  const money = obj(value);
  return money.amount == null
    ? { amount: null, currency: null }
    : { amount: num(money.amount), currency: typeof money.currencyCode === "string" ? money.currencyCode : null };
};
const share = (asinCount: number, totalCount: number): number =>
  totalCount > 0 ? Math.min(1, Math.round((asinCount / totalCount) * 1e6) / 1e6) : 0;

/**
 * Flattens the report's `dataByAsin` entries. Shares are recomputed from the
 * counts instead of read from the document, so they are always fractions and
 * consistent with the counts the leak rules compare them against.
 */
export function parseSearchQueryPerformanceReport(body: string): SearchQueryMetrics[] {
  const document = obj(JSON.parse(body));
  const entries = Array.isArray(document.dataByAsin) ? document.dataByAsin : [];
  const metrics: SearchQueryMetrics[] = [];

  for (const raw of entries) {
    const entry = obj(raw);
    const query = obj(entry.searchQueryData);
    const impressions = obj(entry.impressionData);
    const clicks = obj(entry.clickData);
    const cartAdds = obj(entry.cartAddData);
    const purchases = obj(entry.purchaseData);

    const queryText = typeof query.searchQuery === "string" ? query.searchQuery.trim() : "";
    const asin = typeof entry.asin === "string" ? entry.asin.trim() : "";
    if (!queryText || !asin) continue;

    const totalImpressions = num(impressions.totalQueryImpressionCount);
    const totalClicks = num(clicks.totalClickCount);
    const totalCartAdds = num(cartAdds.totalCartAddCount);
    const totalPurchases = num(purchases.totalPurchaseCount);
    const asinImpressions = num(impressions.asinImpressionCount);
    const asinClicks = num(clicks.asinClickCount);
    const asinCartAdds = num(cartAdds.asinCartAddCount);
    const asinPurchases = num(purchases.asinPurchaseCount);

    const totalPurchasePrice = price(purchases.totalMedianPurchasePrice);
    const totalClickPrice = price(clicks.totalMedianClickPrice);
    const asinPurchasePrice = price(purchases.asinMedianPurchasePrice);
    const asinClickPrice = price(clicks.asinMedianClickPrice);

    metrics.push({
      queryText,
      asin,
      periodStart: String(entry.startDate ?? "").slice(0, 10),
      periodEnd: String(entry.endDate ?? "").slice(0, 10),
      totalQueryVolume: num(query.searchQueryVolume),
      totalImpressions,
      totalClicks,
      totalCartAdds,
      totalPurchases,
      medianPrice: totalPurchasePrice.amount ?? totalClickPrice.amount,
      asinMedianPrice: asinPurchasePrice.amount ?? asinClickPrice.amount,
      currency: totalPurchasePrice.currency ?? totalClickPrice.currency ?? asinClickPrice.currency,
      asinImpressions,
      asinImpressionShare: share(asinImpressions, totalImpressions),
      asinClicks,
      asinClickShare: share(asinClicks, totalClicks),
      asinCartAdds,
      asinCartAddShare: share(asinCartAdds, totalCartAdds),
      asinPurchases,
      asinPurchaseShare: share(asinPurchases, totalPurchases),
    });
  }
  return metrics;
}

/**
 * Adds up several report periods into one row per ASIN and search term.
 * Counts are summed and shares recomputed from the sums; median prices are not
 * additive, so the most recent period that has one is kept. The report only
 * lists a term in the periods where the ASIN showed for it, so the market
 * totals cover those periods only.
 */
export function mergePeriods(metrics: SearchQueryMetrics[]): SearchQueryMetrics[] {
  const merged = new Map<string, SearchQueryMetrics>();
  const oldestFirst = [...metrics].sort((a, b) => a.periodStart.localeCompare(b.periodStart));

  for (const m of oldestFirst) {
    const key = `${m.asin}|${m.queryText}`;
    const sum = merged.get(key);
    if (!sum) {
      merged.set(key, m);
      continue;
    }
    const totalImpressions = sum.totalImpressions + m.totalImpressions;
    const totalClicks = sum.totalClicks + m.totalClicks;
    const totalCartAdds = sum.totalCartAdds + m.totalCartAdds;
    const totalPurchases = sum.totalPurchases + m.totalPurchases;
    const asinImpressions = sum.asinImpressions + m.asinImpressions;
    const asinClicks = sum.asinClicks + m.asinClicks;
    const asinCartAdds = sum.asinCartAdds + m.asinCartAdds;
    const asinPurchases = sum.asinPurchases + m.asinPurchases;
    merged.set(key, {
      queryText: m.queryText,
      asin: m.asin,
      periodStart: sum.periodStart,
      periodEnd: m.periodEnd,
      totalQueryVolume: sum.totalQueryVolume + m.totalQueryVolume,
      totalImpressions,
      totalClicks,
      totalCartAdds,
      totalPurchases,
      medianPrice: m.medianPrice ?? sum.medianPrice,
      asinMedianPrice: m.asinMedianPrice ?? sum.asinMedianPrice,
      currency: m.currency ?? sum.currency,
      asinImpressions,
      asinImpressionShare: share(asinImpressions, totalImpressions),
      asinClicks,
      asinClickShare: share(asinClicks, totalClicks),
      asinCartAdds,
      asinCartAddShare: share(asinCartAdds, totalCartAdds),
      asinPurchases,
      asinPurchaseShare: share(asinPurchases, totalPurchases),
    });
  }
  return [...merged.values()];
}
