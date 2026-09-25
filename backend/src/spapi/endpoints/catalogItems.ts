import type { SpApiClient } from "../client";

export interface CatalogSalesRankDisplayGroup {
  websiteDisplayGroup: string;
  title: string;
  link?: string;
  rank: number;
}

export interface CatalogSalesRankClassification {
  classificationId: string;
  title: string;
  link?: string;
  rank: number;
}

export interface CatalogItemSalesRank {
  marketplaceId: string;
  classificationRanks?: CatalogSalesRankClassification[];
  displayGroupRanks?: CatalogSalesRankDisplayGroup[];
}

export interface CatalogItemResponse {
  asin: string;
  salesRanks?: CatalogItemSalesRank[];
  summaries?: Array<{
    marketplaceId: string;
    itemName?: string;
    brand?: string;
    browseClassification?: {
      displayName: string;
      classificationId: string;
    };
  }>;
}

export async function getCatalogItem(
  client: SpApiClient,
  params: { asin: string; marketplaceIds: string[]; includedData?: string[] }
): Promise<CatalogItemResponse> {
  return client.request<CatalogItemResponse>({
    method: "GET",
    path: `/catalog/2022-04-01/items/${encodeURIComponent(params.asin)}`,
    query: {
      marketplaceIds: params.marketplaceIds.join(","),
      includedData: (params.includedData ?? ["salesRanks", "summaries"]).join(","),
    },
    rateLimitKey: "catalogItems.getCatalogItem",
  });
}
