import type { SpApiClient } from "../client";

export interface InventorySummary {
  sellerSku: string;
  asin: string;
  condition: string;
  inventoryDetails?: {
    fulfillableQuantity: number;
    reservedQuantity: { totalReservedQuantity: number };
    inboundWorkingQuantity: number;
    inboundShippedQuantity: number;
    inboundReceivingQuantity: number;
  };
}

export interface InventorySummariesResponse {
  payload: {
    inventorySummaries: InventorySummary[];
  };
  pagination?: { nextToken?: string };
}

/** GET /fba/inventory/v1/summaries (FBA Inventory API). */
export async function getInventorySummaries(
  client: SpApiClient,
  params: { marketplaceIds: string[]; sellerSkus?: string[]; nextToken?: string }
): Promise<InventorySummariesResponse> {
  return client.request<InventorySummariesResponse>({
    method: "GET",
    path: "/fba/inventory/v1/summaries",
    query: {
      granularityType: "Marketplace",
      granularityId: params.marketplaceIds[0],
      marketplaceIds: params.marketplaceIds.join(","),
      sellerSkus: params.sellerSkus?.join(","),
      nextToken: params.nextToken,
      details: true,
    },
    rateLimitKey: "fbaInventory.getInventorySummaries",
  });
}

/**
 * Days of Cover = current sellable stock / average daily units sold.
 * Returns null when there is no sales velocity to divide by (new/idle SKU).
 */
export function calculateDaysOfCover(fulfillableQuantity: number, avgDailyUnitsSold: number): number | null {
  if (avgDailyUnitsSold <= 0) return null;
  return fulfillableQuantity / avgDailyUnitsSold;
}
