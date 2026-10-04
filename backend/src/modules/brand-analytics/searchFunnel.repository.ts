import type { PrismaClient } from "@prisma/client";
import type { ReportPeriod, SearchQueryMetrics } from "./searchFunnel.types";

export interface StoredSearchQueryMetrics {
  updatedAt: string;
  metrics: SearchQueryMetrics[];
}

export interface SearchQueryMetricsRepository {
  /** Replaces what is stored for these ASINs in the periods the metrics belong to. */
  replace(marketplaceId: string, period: ReportPeriod, asins: string[], metrics: SearchQueryMetrics[]): Promise<void>;
  /** Metrics of the `periods` most recent stored periods, or null when nothing has been synced. */
  latest(marketplaceId: string, period: ReportPeriod, periods?: number): Promise<StoredSearchQueryMetrics | null>;
}

const INSERT_BATCH = 1000;
const asDate = (isoDay: string): Date => new Date(`${isoDay}T00:00:00.000Z`);
const asIsoDay = (date: Date): string => date.toISOString().slice(0, 10);

export function createPrismaSearchQueryMetricsRepository(
  prisma: PrismaClient,
  sellerId: string
): SearchQueryMetricsRepository {
  return {
    async replace(marketplaceId, period, asins, metrics) {
      const periodStarts = [...new Set(metrics.map((m) => m.periodStart))].map(asDate);
      if (!periodStarts.length) return;

      const rows = metrics.map((m) => ({
        sellerId,
        marketplaceId,
        reportPeriod: period,
        ...m,
        periodStart: asDate(m.periodStart),
        periodEnd: asDate(m.periodEnd),
      }));

      await prisma.$transaction(async (tx) => {
        await tx.searchQueryMetric.deleteMany({
          where: { sellerId, marketplaceId, reportPeriod: period, periodStart: { in: periodStarts }, asin: { in: asins } },
        });
        for (let i = 0; i < rows.length; i += INSERT_BATCH) {
          await tx.searchQueryMetric.createMany({ data: rows.slice(i, i + INSERT_BATCH), skipDuplicates: true });
        }
      }, { timeout: 60_000 });
    },

    async latest(marketplaceId, period, periods = 1) {
      const scope = { sellerId, marketplaceId, reportPeriod: period };
      const newest = await prisma.searchQueryMetric.findMany({
        where: scope,
        distinct: ["periodStart"],
        orderBy: { periodStart: "desc" },
        take: periods,
        select: { periodStart: true },
      });
      if (!newest.length) return null;

      const rows = await prisma.searchQueryMetric.findMany({
        where: { ...scope, periodStart: { in: newest.map((row) => row.periodStart) } },
      });
      let updatedAt = 0;
      const metrics = rows.map((row): SearchQueryMetrics => {
        updatedAt = Math.max(updatedAt, row.updatedAt.getTime());
        return {
          queryText: row.queryText,
          asin: row.asin,
          periodStart: asIsoDay(row.periodStart),
          periodEnd: asIsoDay(row.periodEnd),
          totalQueryVolume: row.totalQueryVolume,
          totalImpressions: row.totalImpressions,
          totalClicks: row.totalClicks,
          totalCartAdds: row.totalCartAdds,
          totalPurchases: row.totalPurchases,
          medianPrice: row.medianPrice == null ? null : Number(row.medianPrice),
          asinMedianPrice: row.asinMedianPrice == null ? null : Number(row.asinMedianPrice),
          currency: row.currency,
          asinImpressions: row.asinImpressions,
          asinImpressionShare: row.asinImpressionShare,
          asinClicks: row.asinClicks,
          asinClickShare: row.asinClickShare,
          asinCartAdds: row.asinCartAdds,
          asinCartAddShare: row.asinCartAddShare,
          asinPurchases: row.asinPurchases,
          asinPurchaseShare: row.asinPurchaseShare,
        };
      });
      return { updatedAt: new Date(updatedAt).toISOString(), metrics };
    },
  };
}
