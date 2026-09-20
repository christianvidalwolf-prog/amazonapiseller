import type { SpApiClient } from "../client";

export interface CreateFeedDocumentResponse {
  feedDocumentId: string;
  url: string; // signed S3 PUT URL
}

export interface CreateFeedResponse {
  feedId: string;
}

export interface FeedStatus {
  feedId: string;
  processingStatus: "IN_QUEUE" | "IN_PROGRESS" | "DONE" | "CANCELLED" | "FATAL";
  resultFeedDocumentId?: string;
}

/**
 * Step 1 of a batch upload: reserve an upload slot for the feed payload.
 * POST /feeds/2021-06-30/documents
 */
export async function createFeedDocument(
  client: SpApiClient,
  contentType = "application/json; charset=UTF-8"
): Promise<CreateFeedDocumentResponse> {
  return client.request<CreateFeedDocumentResponse>({
    method: "POST",
    path: "/feeds/2021-06-30/documents",
    body: { contentType },
    rateLimitKey: "feeds.createFeedDocument",
  });
}

/** Step 2: upload the actual JSON_LISTINGS_FEED payload to the signed URL from step 1. */
export async function uploadFeedDocument(uploadUrl: string, document: unknown): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify(document),
  });
  if (!response.ok) {
    throw new Error(`Feed document upload failed (${response.status})`);
  }
}

/**
 * Step 3: submit the feed for processing, referencing the uploaded document.
 * POST /feeds/2021-06-30/feeds
 */
export async function createFeed(
  client: SpApiClient,
  params: { feedType: "JSON_LISTINGS_FEED"; marketplaceIds: string[]; inputFeedDocumentId: string }
): Promise<CreateFeedResponse> {
  return client.request<CreateFeedResponse>({
    method: "POST",
    path: "/feeds/2021-06-30/feeds",
    body: params,
    rateLimitKey: "feeds.createFeed",
  });
}

/** GET /feeds/2021-06-30/feeds/{feedId} — poll until processingStatus is DONE/FATAL/CANCELLED. */
export async function getFeed(client: SpApiClient, feedId: string): Promise<FeedStatus> {
  return client.request<FeedStatus>({
    method: "GET",
    path: `/feeds/2021-06-30/feeds/${feedId}`,
    rateLimitKey: "feeds.getFeed",
  });
}

/**
 * Builds a JSON_LISTINGS_FEED payload from a batch of per-SKU listing
 * operations, per the Feeds API JSON_LISTINGS_FEED message spec.
 */
export function buildJsonListingsFeed(params: {
  sellerId: string;
  messages: Array<{
    sku: string;
    operationType: "UPDATE" | "PARTIAL_UPDATE" | "DELETE";
    productType: string;
    attributes: Record<string, unknown>;
  }>;
}): Record<string, unknown> {
  return {
    header: {
      sellerId: params.sellerId,
      version: "2.0",
    },
    messages: params.messages.map((message, index) => ({
      messageId: index + 1,
      sku: message.sku,
      operationType: message.operationType,
      productType: message.productType,
      attributes: message.attributes,
    })),
  };
}
