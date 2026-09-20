import type { SpApiClient } from "../client";
import { createReport } from "./reports";

/**
 * GET_V2_SELLER_PERFORMANCE_REPORT is requested through the generic Reports
 * API — there is no dedicated seller-performance endpoint. Thin wrapper kept
 * here so account-health code doesn't need to know the underlying report type.
 */
export async function requestSellerPerformanceReport(
  client: SpApiClient,
  params: { marketplaceIds: string[] }
): Promise<{ reportId: string }> {
  return createReport(client, {
    reportType: "GET_V2_SELLER_PERFORMANCE_REPORT",
    marketplaceIds: params.marketplaceIds,
  });
}
