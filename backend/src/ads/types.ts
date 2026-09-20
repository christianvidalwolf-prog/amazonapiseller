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
  metrics: AdMetrics;
}

export interface AdvertisingSummary {
  isConnected: boolean;
  profileId?: string;
  marketplace: string;
  currency: string;
  totalCampaigns: number;
  activeCampaigns: number;
  metrics: {
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
  };
  period: {
    start: string;
    end: string;
  };
  isDemoData?: boolean;
  message?: string;
}
