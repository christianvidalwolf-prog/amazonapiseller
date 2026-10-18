import type { AdsReportRequest } from "./adsClient";

/**
 * Sponsored Products Reporting v3 reports used by the profitability bridge and
 * the negative/harvest proposals. Sales use the 7-day attribution window that
 * Amazon applies to sellers in Sponsored Products.
 */
export type AdsReportKind = "campaigns" | "advertisedProducts" | "searchTerms";

const METRICS = ["impressions", "clicks", "cost", "sales7d", "purchases7d", "unitsSoldClicks7d"];

const DEFINITIONS: Record<AdsReportKind, { reportTypeId: string; groupBy: string[]; columns: string[] }> = {
  campaigns: {
    reportTypeId: "spCampaigns",
    groupBy: ["campaign"],
    columns: ["campaignId", "campaignName", "campaignStatus", ...METRICS],
  },
  advertisedProducts: {
    reportTypeId: "spAdvertisedProduct",
    groupBy: ["advertiser"],
    columns: ["advertisedSku", "advertisedAsin", "campaignId", "adGroupId", ...METRICS, "unitsSoldSameSku7d", "attributedSalesSameSku7d"],
  },
  searchTerms: {
    reportTypeId: "spSearchTerm",
    groupBy: ["searchTerm"],
    columns: ["searchTerm", "keyword", "keywordId", "matchType", "targeting", "campaignId", "adGroupId", ...METRICS],
  },
};

export const ADS_REPORT_KINDS = Object.keys(DEFINITIONS) as AdsReportKind[];

export function buildReportRequest(kind: AdsReportKind, startDate: string, endDate: string): AdsReportRequest {
  const def = DEFINITIONS[kind];
  return {
    name: `${def.reportTypeId} ${startDate}..${endDate}`,
    startDate,
    endDate,
    configuration: { adProduct: "SPONSORED_PRODUCTS", ...def, timeUnit: "SUMMARY", format: "GZIP_JSON" },
  };
}

/** Columns shared by every report row (Amazon may omit zero metrics, hence optional). */
export interface AdsMetricRow {
  impressions?: number;
  clicks?: number;
  cost?: number;
  sales7d?: number;
  purchases7d?: number;
  unitsSoldClicks7d?: number;
  campaignId?: number | string;
}

export interface CampaignReportRow extends AdsMetricRow {
  campaignName?: string;
  campaignStatus?: string;
}

export interface AdvertisedProductReportRow extends AdsMetricRow {
  advertisedSku?: string;
  advertisedAsin?: string;
  adGroupId?: number | string;
  unitsSoldSameSku7d?: number;
  attributedSalesSameSku7d?: number;
}

export interface SearchTermReportRow extends AdsMetricRow {
  searchTerm?: string;
  keyword?: string;
  keywordId?: number | string;
  matchType?: string;
  targeting?: string;
  adGroupId?: number | string;
}

/**
 * Report window: Amazon's attribution data for the last days is incomplete
 * (~72 h), so the window ends `lagDays` before today and spans `days` days.
 */
export function reportWindow(now: Date, days = 30, lagDays = 3): { startDate: string; endDate: string } {
  const day = 86_400_000;
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - lagDays * day);
  const start = new Date(end.getTime() - (days - 1) * day);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}
