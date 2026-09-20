import type { SpApiClient } from "../client";

export interface PricingResponse {
  payload: Array<Record<string, unknown>>;
}

/** GET /products/pricing/v0/price (getPricing). */
export async function getPricing(
  client: SpApiClient,
  params: { marketplaceId: string; asins?: string[]; skus?: string[]; itemType: "Asin" | "Sku" }
): Promise<PricingResponse> {
  return client.request<PricingResponse>({
    method: "GET",
    path: "/products/pricing/v0/price",
    query: {
      MarketplaceId: params.marketplaceId,
      ItemType: params.itemType,
      Asins: params.asins?.join(","),
      Skus: params.skus?.join(","),
    },
    rateLimitKey: "productPricing.getPricing",
  });
}

/** GET /products/pricing/v0/competitivePrice (getCompetitivePricing) — Buy Box signal. */
export async function getCompetitivePricing(
  client: SpApiClient,
  params: { marketplaceId: string; asins: string[] }
): Promise<PricingResponse> {
  return client.request<PricingResponse>({
    method: "GET",
    path: "/products/pricing/v0/competitivePrice",
    query: {
      MarketplaceId: params.marketplaceId,
      ItemType: "Asin",
      Asins: params.asins.join(","),
      CustomerType: "Consumer",
    },
    rateLimitKey: "productPricing.getCompetitivePricing",
  });
}

/** GET /products/pricing/v0/items/{asin}/offers — Desglose de competidores y ofertas. */
export async function getItemOffers(
  client: SpApiClient,
  params: { marketplaceId: string; asin: string; itemCondition?: "New" | "Used" | "Collectible" | "Refurbished" | "Club" }
): Promise<{ payload: Record<string, unknown> }> {
  return client.request<{ payload: Record<string, unknown> }>({
    method: "GET",
    path: `/products/pricing/v0/items/${encodeURIComponent(params.asin)}/offers`,
    query: {
      MarketplaceId: params.marketplaceId,
      ItemCondition: params.itemCondition ?? "New",
      CustomerType: "Consumer",
    },
    rateLimitKey: "productPricing.getItemOffers",
  });
}
