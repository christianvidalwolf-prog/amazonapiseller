import { type AdsApiClient, AdsApiError } from "../../ads/adsClient";
import type {
  AdCampaign,
  AdsConnectionStatus,
  AdsErrorInfo,
  AdsProfile,
  AdvertisingCampaignsResponse,
  AdvertisingSummary,
  AdvertisingSummaryMetrics,
} from "../../ads/types";

const DEFAULT_WINDOW_DAYS = 30;
const NOT_CONFIGURED: AdsErrorInfo = {
  kind: "not_configured",
  message: "Faltan credenciales de Amazon Ads en .env (ADS_API_CLIENT_ID, ADS_API_CLIENT_SECRET o ADS_API_REFRESH_TOKEN).",
};
const NO_PERFORMANCE_DATA =
  "Conectado a Amazon Ads, pero sin informes de rendimiento para el periodo: métricas no concluyentes.";

/** Spec §5: metrics are conclusive only if present and not all zero. */
export function isConclusive(metrics: AdvertisingSummaryMetrics | null): metrics is AdvertisingSummaryMetrics {
  return metrics !== null && (metrics.impressions > 0 || metrics.clicks > 0 || metrics.spend > 0);
}

export function toErrorInfo(err: unknown): AdsErrorInfo {
  if (err instanceof AdsApiError) return { kind: err.kind, message: err.message };
  return { kind: "network", message: err instanceof Error ? err.message : String(err) };
}

/**
 * Amazon Ads panel. Never fabricates numbers: whenever real performance data is
 * missing, the response says "inconclusive" and why (spec advertising §5).
 */
export class AdvertisingService {
  constructor(
    private readonly adsClient: AdsApiClient,
    private readonly marketplaceId: string,
    private readonly configuredProfileId?: string
  ) {}

  async getConnectionStatus(): Promise<AdsConnectionStatus> {
    if (!this.adsClient.isConfigured()) {
      return { isConfigured: false, isConnected: false, error: NOT_CONFIGURED };
    }
    let profiles: AdsProfile[];
    try {
      profiles = await this.adsClient.getProfiles();
    } catch (err) {
      return { isConfigured: true, isConnected: false, error: this.logged(toErrorInfo(err)) };
    }
    const profile = this.resolveProfile(profiles);
    if (!profile) {
      const message = this.configuredProfileId
        ? `ADS_API_PROFILE_ID ${this.configuredProfileId} no está entre los ${profiles.length} perfiles autorizados.`
        : `Ningún perfil de Amazon Ads para el marketplace ${this.marketplaceId} (${profiles.length} perfiles autorizados).`;
      return { isConfigured: true, isConnected: false, profiles, error: this.logged({ kind: "client", message }) };
    }
    return { isConfigured: true, isConnected: true, profileId: String(profile.profileId), profile, profiles };
  }

  async getProfiles(): Promise<AdsProfile[]> {
    return this.adsClient.getProfiles();
  }

  async getSummary(startDate?: string, endDate?: string): Promise<AdvertisingSummary> {
    const period = this.period(startDate, endDate);
    const status = await this.getConnectionStatus();
    if (!status.isConnected || !status.profileId) {
      return this.inconclusiveSummary(period, status);
    }
    let campaigns: AdCampaign[];
    try {
      campaigns = await this.adsClient.listSponsoredProductsCampaigns(status.profileId);
    } catch (err) {
      return this.inconclusiveSummary(period, { ...status, isConnected: false, error: this.logged(toErrorInfo(err)) });
    }
    // Performance metrics need the Reporting API (Proceso 1); until then nothing is conclusive.
    return {
      dataStatus: "inconclusive",
      inconclusiveReason: "no_performance_data",
      isConnected: true,
      profileId: status.profileId,
      marketplace: status.profile?.countryCode,
      currency: status.profile?.currencyCode,
      totalCampaigns: campaigns.length,
      activeCampaigns: campaigns.filter((c) => c.state === "enabled").length,
      metrics: null,
      period,
      message: NO_PERFORMANCE_DATA,
    };
  }

  async getCampaigns(): Promise<AdvertisingCampaignsResponse> {
    const status = await this.getConnectionStatus();
    if (!status.isConnected || !status.profileId) {
      return {
        dataStatus: "inconclusive",
        inconclusiveReason: status.isConfigured ? "connection_error" : "not_configured",
        campaigns: [],
        error: status.error,
      };
    }
    try {
      const campaigns = await this.adsClient.listSponsoredProductsCampaigns(status.profileId);
      return {
        dataStatus: "inconclusive",
        inconclusiveReason: "no_performance_data",
        profileId: status.profileId,
        campaigns,
        message: NO_PERFORMANCE_DATA,
      };
    } catch (err) {
      return {
        dataStatus: "inconclusive",
        inconclusiveReason: "connection_error",
        profileId: status.profileId,
        campaigns: [],
        error: this.logged(toErrorInfo(err)),
      };
    }
  }

  /** Configured profile must be one Amazon authorized; otherwise pick the one selling in our marketplace — never "the first". */
  private resolveProfile(profiles: AdsProfile[]): AdsProfile | undefined {
    if (this.configuredProfileId) {
      return profiles.find((p) => String(p.profileId) === this.configuredProfileId);
    }
    return profiles.find((p) => p.accountInfo?.marketplaceStringId === this.marketplaceId);
  }

  private inconclusiveSummary(period: AdvertisingSummary["period"], status: AdsConnectionStatus): AdvertisingSummary {
    return {
      dataStatus: "inconclusive",
      inconclusiveReason: status.isConfigured ? "connection_error" : "not_configured",
      isConnected: false,
      profileId: status.profileId,
      totalCampaigns: 0,
      activeCampaigns: 0,
      metrics: null,
      period,
      message: status.error?.message,
      error: status.error,
    };
  }

  private period(startDate?: string, endDate?: string): AdvertisingSummary["period"] {
    const end = endDate || new Date().toISOString().slice(0, 10);
    const start = startDate || new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    return { start, end };
  }

  /** Spec §5: no silent failures — every Ads error is logged with its kind. */
  private logged(error: AdsErrorInfo): AdsErrorInfo {
    console.warn(`[advertising] ${error.kind}: ${error.message}`);
    return error;
  }
}
