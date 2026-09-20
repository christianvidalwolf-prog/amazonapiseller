import type { SpApiClient } from "../client";

export interface ProductTypeDefinition {
  productType: string;
  productTypeVersion: { version: string; latest: boolean; releaseCandidate: boolean };
  /** URL to the actual JSON Schema document (Amazon serves it out-of-band). */
  schema: { link: { resource: string; verb: "GET" }; checksum: string };
  requirements: string;
  propertyGroups?: Record<string, { title: string; propertyNames: string[] }>;
}

/**
 * GET /definitions/2020-09-01/productTypes/{productType}
 * Returns metadata + a link to the JSON Schema for the given product type
 * and marketplace. The schema itself must be fetched separately from
 * `schema.link.resource` (a signed S3 URL, not an SP-API endpoint).
 */
export async function getProductTypeDefinition(
  client: SpApiClient,
  params: { productType: string; marketplaceId: string; sellerId: string }
): Promise<ProductTypeDefinition> {
  return client.request<ProductTypeDefinition>({
    method: "GET",
    path: `/definitions/2020-09-01/productTypes/${encodeURIComponent(params.productType)}`,
    query: {
      marketplaceIds: params.marketplaceId,
      sellerId: params.sellerId,
      requirements: "LISTING",
    },
    rateLimitKey: "productTypeDefinitions.getDefinitionsProductType",
  });
}

/** Fetches and parses the JSON Schema document a definition points to. */
export async function fetchProductTypeSchema(definition: ProductTypeDefinition): Promise<Record<string, unknown>> {
  const response = await fetch(definition.schema.link.resource);
  if (!response.ok) {
    throw new Error(`Failed to download product type schema (${response.status})`);
  }
  return (await response.json()) as Record<string, unknown>;
}
