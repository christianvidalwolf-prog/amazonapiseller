import type { SpApiClient } from "../client";

interface MoneyType {
  CurrencyCode?: string;
  Amount?: number;
}

export interface FeeDetail {
  FeeType?: string;
  FeeAmount?: MoneyType;
  FeePromotion?: MoneyType;
  FinalFeeAmount?: MoneyType;
  [key: string]: unknown;
}

export interface FeesEstimate {
  TimeOfFeesEstimate?: string;
  TotalFeesEstimate?: MoneyType;
  FeeDetails?: FeeDetail[];
}

export interface FeesEstimateResult {
  Status?: string;
  FeesEstimateIdentifier?: Record<string, unknown>;
  FeesEstimate?: FeesEstimate;
  Error?: { Code?: string; Message?: string };
}

export interface FeesEstimateResponse {
  payload: { FeesEstimateResult?: FeesEstimateResult };
}

/**
 * POST /products/fees/v0/listings/{SellerSKU}/feesEstimate (getMyFeesEstimateForSKU).
 * `isAmazonFulfilled: true` estima las tarifas FBA (referral + fulfillment);
 * `false` estima FBM (referral + closing fee, sin fulfillment).
 */
export async function getMyFeesEstimateForSKU(
  client: SpApiClient,
  params: {
    marketplaceId: string;
    sku: string;
    price: number;
    currency: string;
    shipping?: number;
    isAmazonFulfilled: boolean;
  }
): Promise<FeesEstimateResponse> {
  return client.request<FeesEstimateResponse>({
    method: "POST",
    path: `/products/fees/v0/listings/${encodeURIComponent(params.sku)}/feesEstimate`,
    body: {
      FeesEstimateRequest: {
        MarketplaceId: params.marketplaceId,
        IsAmazonFulfilled: params.isAmazonFulfilled,
        PriceToEstimateFees: {
          ListingPrice: { CurrencyCode: params.currency, Amount: params.price },
          Shipping: { CurrencyCode: params.currency, Amount: params.shipping ?? 0 },
        },
        Identifier: `margin-${params.sku}`,
      },
    },
    rateLimitKey: "productFees.getMyFeesEstimateForSKU",
  });
}

/** Extrae un desglose legible del resultado del estimate. */
export function extractFeeBreakdown(result: FeesEstimateResult | undefined): {
  totalFees: number | null;
  currency: string | null;
  referralFee: number | null;
  fulfillmentFee: number | null;
  closingFee: number | null;
  perItemFee: number | null;
  details: Array<{ feeType: string; amount: number }>;
} {
  const estimate = result?.FeesEstimate;
  const details = (estimate?.FeeDetails ?? []).map((d) => ({
    feeType: String(d.FeeType ?? "Unknown"),
    amount: Number(d.FinalFeeAmount?.Amount ?? d.FeeAmount?.Amount ?? 0),
  }));
  const find = (prefix: string) =>
    details.filter((d) => d.feeType.toLowerCase().includes(prefix)).reduce((sum, d) => sum + d.amount, 0);
  const total = Number(estimate?.TotalFeesEstimate?.Amount ?? NaN);
  return {
    totalFees: Number.isFinite(total) ? total : null,
    currency: estimate?.TotalFeesEstimate?.CurrencyCode ?? null,
    referralFee: details.some((d) => d.feeType.toLowerCase().includes("referral")) ? find("referral") : null,
    fulfillmentFee: details.some((d) => /fulfil|fulfill|pickandpack/i.test(d.feeType)) ? find("fulfil") + find("pickandpack") : null,
    closingFee: details.some((d) => d.feeType.toLowerCase().includes("closing")) ? find("closing") : null,
    perItemFee: details.some((d) => d.feeType.toLowerCase().includes("peritem")) ? find("peritem") : null,
    details: details.filter((d) => d.amount !== 0),
  };
}
