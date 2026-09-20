import type { SpApiClient } from "../client";

export interface OrdersResponse {
  payload: {
    Orders: Array<Record<string, unknown>>;
    NextToken?: string;
  };
}

/** GET /orders/v0/orders — recent-orders quick lookup (Orders API). */
export async function getOrders(
  client: SpApiClient,
  params: { marketplaceIds: string[]; createdAfter: string; nextToken?: string }
): Promise<OrdersResponse> {
  return client.request<OrdersResponse>({
    method: "GET",
    path: "/orders/v0/orders",
    query: {
      MarketplaceIds: params.marketplaceIds.join(","),
      CreatedAfter: params.createdAfter,
      NextToken: params.nextToken,
    },
    rateLimitKey: "orders.getOrders",
  });
}
