import type { SpApiRegion } from "../spapi/types";

export interface AdsApiCredentials {
  lwaClientId: string;
  lwaClientSecret: string;
  refreshToken: string;
  profileId?: string;
  region: SpApiRegion;
}

export interface AdsProfile {
  profileId: number | string;
  countryCode: string;
  currencyCode: string;
  timezone: string;
  accountInfo: {
    marketplaceStringId: string;
    sellerStringId?: string;
    type: string;
    name: string;
  };
}

export interface AdMetrics {
  impressions: number;
  clicks: number;
  cost: number;
  sales: number;
  orders: number;
  cpc: number;
  ctr: number;
  acos: number;
  roas: number;
}

export interface AdCampaign {
  campaignId: string;
  name: string;
  campaignType: "sponsoredProducts" | "sponsoredBrands" | "sponsoredDisplay";
  targetingType?: "manual" | "auto";
  state: "enabled" | "paused" | "archived";
  dailyBudget: number;
  startDate?: string;
  endDate?: string;
  /** null until performance reports are wired in — never zero-filled or simulated. */
  metrics: AdMetrics | null;
}

/** Why a call failed: permissions vs. data vs. transport. */
export type AdsErrorKind = "not_configured" | "auth" | "throttled" | "client" | "server" | "network";

export interface AdsErrorInfo {
  kind: AdsErrorKind;
  message: string;
}

/**
 * Golden rule (spec §5): no data or zero data ⇒ "inconclusive", never numbers.
 * - not_configured: credentials missing
 * - connection_error: Amazon Ads call failed (see `error.kind`)
 * - no_performance_data: connected, but no performance report covers the period, or all of it is zero
 */
export type AdsDataStatus = "ok" | "inconclusive";
export type AdsInconclusiveReason = "not_configured" | "connection_error" | "no_performance_data";

export interface AdvertisingSummaryMetrics {
  spend: number;
  attributedSales: number;
  totalStoreSales: number;
  clicks: number;
  impressions: number;
  cpc: number;
  ctr: number;
  acos: number;
  roas: number;
  tacos: number;
}

export interface AdvertisingSummary {
  dataStatus: AdsDataStatus;
  inconclusiveReason?: AdsInconclusiveReason;
  isConnected: boolean;
  profileId?: string;
  marketplace?: string;
  currency?: string;
  totalCampaigns: number;
  activeCampaigns: number;
  metrics: AdvertisingSummaryMetrics | null;
  period: {
    start: string;
    end: string;
  };
  message?: string;
  error?: AdsErrorInfo;
}

export interface AdvertisingCampaignsResponse {
  dataStatus: AdsDataStatus;
  inconclusiveReason?: AdsInconclusiveReason;
  profileId?: string;
  campaigns: AdCampaign[];
  message?: string;
  error?: AdsErrorInfo;
}

export interface AdsConnectionStatus {
  isConfigured: boolean;
  isConnected: boolean;
  profileId?: string;
  profile?: AdsProfile;
  profiles?: AdsProfile[];
  error?: AdsErrorInfo;
}
