import type { SpApiClient } from "../../spapi/client";
import { buildJsonListingsFeed, createFeed, createFeedDocument, getFeed, uploadFeedDocument } from "../../spapi/endpoints/feeds";
import type { ListingsItemPayload, ListingsItemSubmissionResponse } from "../../spapi/endpoints/listingsItems";
import { type ListingsItemPatch, patchListingsItem, previewListingsItem, putListingsItem } from "../../spapi/endpoints/listingsItems";
import { fetchProductTypeSchema, getProductTypeDefinition } from "../../spapi/endpoints/productTypeDefinitions";
import { SpApiError } from "../../spapi/types";

export interface ListingValidationResult {
  valid: boolean;
  errors: Array<{ code: string; message: string; attributeNames?: string[] }>;
  warnings: Array<{ code: string; message: string; attributeNames?: string[] }>;
}

/**
 * Persistence seam so this service doesn't hard-depend on Prisma being
 * wired up yet. `backend/src/db` provides a real implementation once the
 * schema module lands; tests/dev can pass a no-op.
 */
export interface ListingSubmissionRepository {
  saveSubmission(record: {
    sku: string;
    productType: string;
    submissionId: string;
    marketplaceId?: string;
    status: ListingsItemSubmissionResponse["status"];
    issues: ListingsItemSubmissionResponse["issues"];
  }): Promise<void>;
  getLatestSubmission?(sku: string, marketplaceId?: string): Promise<{
    submissionId: string;
    status: string;
    marketplaceId?: string | null;
    issues: unknown;
    createdAt: Date;
  } | null>;
}

export const noopSubmissionRepository: ListingSubmissionRepository = {
  async saveSubmission() {
    /* no-op default */
  },
};

export interface ListingsServiceContext {
  sellerId: string;
  marketplaceIds: string[];
}

export class ListingsService {
  private readonly schemaCache = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly client: SpApiClient,
    private readonly context: ListingsServiceContext,
    private readonly repository: ListingSubmissionRepository = noopSubmissionRepository
  ) {}

  /**
   * Fetches the JSON Schema Amazon expects for `productType` in
   * `marketplaceId`, driving dynamic form generation / validation on the
   * frontend. Cached per (productType, marketplaceId) for the process
   * lifetime — schemas change rarely and the lookup costs a real SP-API call.
   */
  async getProductTypeSchema(productType: string, marketplaceId: string): Promise<Record<string, unknown>> {
    const cacheKey = `${productType}:${marketplaceId}`;
    const cached = this.schemaCache.get(cacheKey);
    if (cached) return cached;

    const definition = await getProductTypeDefinition(this.client, {
      productType,
      marketplaceId,
      sellerId: this.context.sellerId,
    });
    const schema = await fetchProductTypeSchema(definition);
    this.schemaCache.set(cacheKey, schema);
    return schema;
  }

  /**
   * Calls Listings Items `preview-errors` to validate a payload (EAN/UPC,
   * dimensions, variant theme, required attributes, ...) without publishing
   * it. Always run this before submitListingItem.
   */
  async validateListing(sku: string, payload: ListingsItemPayload): Promise<ListingValidationResult> {
    const response = await previewListingsItem(
      this.client,
      { sellerId: this.context.sellerId, sku, marketplaceIds: this.context.marketplaceIds },
      payload
    );

    const issues = response.issues ?? [];
    return {
      valid: response.status !== "INVALID",
      errors: issues.filter((issue) => issue.severity === "ERROR"),
      warnings: issues.filter((issue) => issue.severity !== "ERROR"),
    };
  }

  /**
   * Creates or fully replaces a single listing item (putListingsItem) and
   * persists the resulting submissionId + issues for later status lookup.
   * Amazon processes listings asynchronously: ACCEPTED here means the
   * submission was queued, not that the listing is live.
   */
  async submitListingItem(sku: string, payload: ListingsItemPayload): Promise<ListingsItemSubmissionResponse> {
    const response = await putListingsItem(
      this.client,
      { sellerId: this.context.sellerId, sku, marketplaceIds: this.context.marketplaceIds },
      payload
    );

    await this.repository.saveSubmission({
      sku,
      productType: payload.productType,
      submissionId: response.submissionId,
      status: response.status,
      issues: response.issues,
    });

    return response;
  }

  /**
   * Partial update (JSON Patch) for cheap, high-frequency changes like price
   * or quantity, instead of resubmitting the full attribute set.
   */
  async patchListingItem(
    sku: string,
    patch: ListingsItemPatch,
    marketplaceIds?: string[]
  ): Promise<ListingsItemSubmissionResponse> {
    const targetMarketplaces = marketplaceIds && marketplaceIds.length > 0 ? marketplaceIds : this.context.marketplaceIds;
    const response = await patchListingsItem(
      this.client,
      { sellerId: this.context.sellerId, sku, marketplaceIds: targetMarketplaces },
      patch
    );

    await this.repository.saveSubmission({
      sku,
      productType: patch.productType,
      submissionId: response.submissionId,
      marketplaceId: targetMarketplaces[0],
      status: response.status,
      issues: response.issues,
    });

    return response;
  }

  async getLatestSubmission(sku: string, marketplaceId?: string) {
    return this.repository.getLatestSubmission?.(sku, marketplaceId) ?? null;
  }

  /**
   * Convenience helper to update price and/or stock for a specific marketplace.
   */
  async updatePriceOrStock(params: {
    sku: string;
    price?: number;
    stock?: number;
    leadTimeDays?: number;
    currency?: string;
    marketplaceId?: string;
  }): Promise<ListingsItemSubmissionResponse> {
    const patches: ListingsItemPatch["patches"] = [];
    const mkId = params.marketplaceId || this.context.marketplaceIds[0];
    const currency = params.currency || "EUR";

    if (typeof params.price === "number") {
      patches.push({
        op: "replace",
        path: "/attributes/purchasable_offer",
        value: [
          {
            currency,
            marketplace_id: mkId,
            our_price: [
              {
                schedule: [
                  {
                    value_with_tax: Number(params.price.toFixed(2)),
                  },
                ],
              },
            ],
          },
        ],
      });
    }

    if (typeof params.stock === "number") {
      patches.push({
        op: "replace",
        path: "/attributes/fulfillment_availability",
        value: [
          {
            fulfillment_channel_code: "DEFAULT",
            quantity: Math.floor(params.stock),
            lead_time_to_ship_max_days: params.leadTimeDays ?? 2,
          },
        ],
      });
    }

    if (patches.length === 0) {
      throw new Error("Debes proporcionar al menos precio o stock para actualizar.");
    }

    return this.patchListingItem(
      params.sku,
      {
        productType: "PRODUCT",
        patches,
      },
      [mkId]
    );
  }

  /**
   * Batch path for bulk catalog uploads: builds a JSON_LISTINGS_FEED,
   * uploads it, submits it, and returns the feedId to poll (via getFeed) —
   * use this instead of N individual submitListingItem calls when N is large,
   * since feeds run off the same rate-limited buckets but process off-band.
   */
  async submitListingsBatch(
    messages: Array<{ sku: string; operationType: "UPDATE" | "PARTIAL_UPDATE" | "DELETE"; productType: string; attributes: Record<string, unknown> }>
  ): Promise<{ feedId: string }> {
    const document = buildJsonListingsFeed({ sellerId: this.context.sellerId, messages });

    const { feedDocumentId, url } = await createFeedDocument(this.client);
    await uploadFeedDocument(url, document);

    const { feedId } = await createFeed(this.client, {
      feedType: "JSON_LISTINGS_FEED",
      marketplaceIds: this.context.marketplaceIds,
      inputFeedDocumentId: feedDocumentId,
    });

    return { feedId };
  }

  /** Polls feed processing status; callers typically wrap this in a worker with backoff. */
  async getBatchStatus(feedId: string) {
    return getFeed(this.client, feedId);
  }

  /** True when the error is a 4xx validation failure rather than a transport/throttling issue. */
  static isValidationError(error: unknown): error is SpApiError {
    return error instanceof SpApiError && error.statusCode >= 400 && error.statusCode < 500 && !error.isThrottled;
  }
}
