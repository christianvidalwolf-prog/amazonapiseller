import { LwaAuthManager } from "../spapi/lwaAuth";
import type { SpApiRegion } from "../spapi/types";
import type { AdsApiCredentials, AdsProfile, AdCampaign, AdMetrics } from "./types";

const ADS_REGION_ENDPOINTS: Record<SpApiRegion, string> = {
  EU: "https://advertising-api-eu.amazon.com",
  NA: "https://advertising-api.amazon.com",
  FE: "https://advertising-api-fe.amazon.com",
};

export class AdsApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AdsApiError";
  }
}

export class AdsApiClient {
  private readonly auth: LwaAuthManager;
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly profileId?: string;

  constructor(private readonly credentials: AdsApiCredentials) {
    this.auth = new LwaAuthManager({
      lwaClientId: credentials.lwaClientId,
      lwaClientSecret: credentials.lwaClientSecret,
      refreshToken: credentials.refreshToken,
      region: credentials.region,
    });
    this.baseUrl = ADS_REGION_ENDPOINTS[credentials.region];
    this.clientId = credentials.lwaClientId;
    this.profileId = credentials.profileId;
  }

  isConfigured(): boolean {
    return Boolean(this.credentials.lwaClientId && this.credentials.refreshToken);
  }

  async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      profileId?: string;
      body?: unknown;
      headers?: Record<string, string>;
      query?: Record<string, string | number | boolean | undefined>;
    } = {}
  ): Promise<T> {
    const accessToken = await this.auth.getAccessToken();
    const effectiveProfileId = options.profileId || this.profileId;

    let url = `${this.baseUrl}${path}`;
    if (options.query) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) {
          searchParams.append(key, String(value));
        }
      }
      const qs = searchParams.toString();
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Amazon-Advertising-API-ClientId": this.clientId,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...options.headers,
    };

    if (effectiveProfileId && !path.startsWith("/v2/profiles")) {
      headers["Amazon-Advertising-API-Scope"] = String(effectiveProfileId);
    }

    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      let errorData: unknown;
      try {
        errorData = JSON.parse(text);
      } catch {
        errorData = text;
      }
      throw new AdsApiError(
        response.status,
        `Amazon Ads API request failed [${response.status}] ${path}: ${typeof errorData === "object" ? JSON.stringify(errorData) : text}`,
        errorData
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Fetches all advertising profiles for the authorized account.
   */
  async getProfiles(): Promise<AdsProfile[]> {
    return this.request<AdsProfile[]>("/v2/profiles");
  }

  /**
   * Lists Sponsored Products campaigns.
   */
  async listSponsoredProductsCampaigns(profileId?: string): Promise<AdCampaign[]> {
    // Try v3 SP list first, fallback to v2 if needed
    try {
      const data = await this.request<{
        campaigns?: Array<{
          campaignId: string;
          name: string;
          state: string;
          budget?: { budget: number };
          targetingType?: string;
          startDate?: string;
          endDate?: string;
        }>;
      }>("/sp/campaigns/list", {
        method: "POST",
        profileId,
        body: {},
        headers: {
          Accept: "application/vnd.spCampaign.v3+json",
          "Content-Type": "application/vnd.spCampaign.v3+json",
        },
      });

      if (data && Array.isArray(data.campaigns)) {
        return data.campaigns.map((c) => ({
          campaignId: String(c.campaignId),
          name: c.name,
          campaignType: "sponsoredProducts",
          targetingType: (c.targetingType?.toLowerCase() as "manual" | "auto") || "manual",
          state: (c.state?.toLowerCase() as "enabled" | "paused" | "archived") || "enabled",
          dailyBudget: Number(c.budget?.budget ?? 0),
          startDate: c.startDate,
          endDate: c.endDate,
          metrics: {
            impressions: 0,
            clicks: 0,
            cost: 0,
            sales: 0,
            orders: 0,
            cpc: 0,
            ctr: 0,
            acos: 0,
            roas: 0,
          },
        }));
      }
    } catch {
      // Fallback to v2
    }

    // Try v2 SP campaigns endpoint
    const campaignsV2 = await this.request<
      Array<{
        campaignId: number | string;
        name: string;
        campaignType: string;
        targetingType: string;
        state: string;
        dailyBudget: number;
        startDate: string;
      }>
    >("/v2/sp/campaigns", {
      method: "GET",
      profileId,
    });

    return (campaignsV2 || []).map((c) => ({
      campaignId: String(c.campaignId),
      name: c.name,
      campaignType: "sponsoredProducts",
      targetingType: (c.targetingType?.toLowerCase() as "manual" | "auto") || "manual",
      state: (c.state?.toLowerCase() as "enabled" | "paused" | "archived") || "enabled",
      dailyBudget: Number(c.dailyBudget ?? 0),
      startDate: c.startDate,
      metrics: {
        impressions: 0,
        clicks: 0,
        cost: 0,
        sales: 0,
        orders: 0,
        cpc: 0,
        ctr: 0,
        acos: 0,
        roas: 0,
      },
    }));
  }
}
