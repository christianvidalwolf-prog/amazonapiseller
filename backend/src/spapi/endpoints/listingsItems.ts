import type { SpApiClient } from "../client";

export interface ListingsItemIssue {
  code: string;
  message: string;
  severity: "ERROR" | "WARNING" | "INFO";
  attributeNames?: string[];
}

export interface ListingsItemSubmissionResponse {
  sku: string;
  status: "ACCEPTED" | "INVALID" | "VALID";
  submissionId: string;
  issues?: ListingsItemIssue[];
}

export interface ListingsItemPayload {
  productType: string;
  requirements?: "LISTING" | "LISTING_PRODUCT_ONLY" | "LISTING_OFFER_ONLY";
  attributes: Record<string, unknown>;
}

interface ListingsItemParams {
  sellerId: string;
  sku: string;
  marketplaceIds: string[];
}

/**
 * POST .../listings/2021-08-01/items/{sellerId}/{sku}/preview-errors
 * Validates attributes against the product type schema WITHOUT publishing.
 * Always call this before putListingsItem/patchListingsItem in the flow.
 */
export async function previewListingsItem(
  client: SpApiClient,
  params: ListingsItemParams,
  payload: ListingsItemPayload
): Promise<ListingsItemSubmissionResponse> {
  return client.request<ListingsItemSubmissionResponse>({
    method: "POST",
    path: `/listings/2021-08-01/items/${params.sellerId}/${encodeURIComponent(params.sku)}/preview-errors`,
    query: { marketplaceIds: params.marketplaceIds.join(",") },
    body: payload,
    rateLimitKey: "listingsItems.previewListingsItem",
  });
}

/**
 * PUT .../listings/2021-08-01/items/{sellerId}/{sku}
 * Full create/replace of a listing item.
 */
export async function putListingsItem(
  client: SpApiClient,
  params: ListingsItemParams,
  payload: ListingsItemPayload
): Promise<ListingsItemSubmissionResponse> {
  return client.request<ListingsItemSubmissionResponse>({
    method: "PUT",
    path: `/listings/2021-08-01/items/${params.sellerId}/${encodeURIComponent(params.sku)}`,
    query: { marketplaceIds: params.marketplaceIds.join(",") },
    body: payload,
    rateLimitKey: "listingsItems.putListingsItem",
  });
}

export interface ListingsItemPatch {
  productType: string;
  patches: Array<{
    op: "add" | "replace" | "delete";
    path: string; // JSON Pointer, e.g. "/attributes/list_price"
    value?: unknown[];
  }>;
}

/**
 * PATCH .../listings/2021-08-01/items/{sellerId}/{sku}
 * Partial update (JSON Patch) of a listing item — cheaper than a full put
 * when only a few attributes (price, quantity, images) change.
 */
export async function patchListingsItem(
  client: SpApiClient,
  params: ListingsItemParams,
  payload: ListingsItemPatch
): Promise<ListingsItemSubmissionResponse> {
  return client.request<ListingsItemSubmissionResponse>({
    method: "PATCH",
    path: `/listings/2021-08-01/items/${params.sellerId}/${encodeURIComponent(params.sku)}`,
    query: { marketplaceIds: params.marketplaceIds.join(",") },
    body: payload,
    rateLimitKey: "listingsItems.patchListingsItem",
  });
}

/** GET .../listings/2021-08-01/items/{sellerId}/{sku} */
export async function getListingsItem(
  client: SpApiClient,
  params: ListingsItemParams & { includedData?: string[] }
): Promise<Record<string, unknown>> {
  return client.request<Record<string, unknown>>({
    method: "GET",
    path: `/listings/2021-08-01/items/${params.sellerId}/${encodeURIComponent(params.sku)}`,
    query: {
      marketplaceIds: params.marketplaceIds.join(","),
      includedData: (params.includedData ?? ["summaries", "attributes", "issues"]).join(","),
    },
    rateLimitKey: "listingsItems.getListingsItem",
  });
}
