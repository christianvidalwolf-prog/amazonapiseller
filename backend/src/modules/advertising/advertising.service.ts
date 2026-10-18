import { type AdsApiClient, AdsApiError } from "../../ads/adsClient";
import type { AdsReportKind, AdvertisedProductReportRow, CampaignReportRow } from "../../ads/reportTypes";
import type {
  AdCampaign,
  AdsConnectionStatus,
  AdsErrorInfo,
  AdsProfile,
  AdvertisingCampaignsResponse,
  AdvertisingSummary,
} from "../../ads/types";
import type { AdMarginsSnapshot } from "./adMargins";
import type { AdsReportStore, StoredAdsReport } from "./adsReports.store";
import { adsMarginsKey } from "./adsReports.store";
import { isConclusive, salesChannelFor, toAdMetrics, toSummaryMetrics } from "./advertising.metrics";
import { computeProfitability, type MarginInput, type ProfitabilityTotals, type SkuProfitability, unitProfitBeforeAds } from "./profitability";

export { isConclusive } from "./advertising.metrics";

const NOT_CONFIGURED: AdsErrorInfo = {
  kind: "not_configured",
  message: "Faltan credenciales de Amazon Ads en .env (ADS_API_CLIENT_ID, ADS_API_CLIENT_SECRET o ADS_API_REFRESH_TOKEN).",
};
const NO_PERFORMANCE_DATA =
  "Conectado a Amazon Ads, pero sin informes de rendimiento con actividad: métricas no concluyentes (npm run ads:sync-reports).";
const MARGINS_SNAPSHOT_KEY = "margins:products";

export interface AdvertisingServiceDeps {
  reports?: AdsReportStore;
  /** Revenue of one sales channel (e.g. "Amazon.es") between two ISO dates, or null if unknown. */
  storeSales?: (startDate: string, endDate: string, channel: string) => Promise<number | null>;
}

export interface AdvertisingProfitabilityResponse {
  dataStatus: AdvertisingSummary["dataStatus"];
  inconclusiveReason?: AdvertisingSummary["inconclusiveReason"];
  profileId?: string;
  period?: { start: string; end: string };
  reportGeneratedAt?: string;
  totals?: ProfitabilityTotals;
  skus: SkuProfitability[];
  message?: string;
  error?: AdsErrorInfo;
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
    private readonly configuredProfileId?: string,
    private readonly deps: AdvertisingServiceDeps = {}
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

  /** Metrics of the last stored campaigns report (window ends 3 days ago, spec §6). */
  async getSummary(): Promise<AdvertisingSummary> {
    const status = await this.getConnectionStatus();
    if (!status.isConnected || !status.profileId) return this.inconclusiveSummary(status);
    let campaigns: AdCampaign[];
    let report: StoredAdsReport<CampaignReportRow> | null;
    try {
      campaigns = await this.adsClient.listSponsoredProductsCampaigns(status.profileId);
      report = await this.loadReport<CampaignReportRow>(status.profileId, "campaigns");
    } catch (err) {
      return this.inconclusiveSummary({ ...status, isConnected: false, error: this.logged(toErrorInfo(err)) });
    }
    const base = {
      isConnected: true,
      profileId: status.profileId,
      marketplace: status.profile?.countryCode,
      currency: status.profile?.currencyCode,
      totalCampaigns: campaigns.length,
      activeCampaigns: campaigns.filter((c) => c.state === "enabled").length,
    };
    const period = report ? { start: report.startDate, end: report.endDate } : this.emptyPeriod();
    const metrics = report ? toSummaryMetrics(toAdMetrics(report.rows), await this.channelSales(period, status.profile?.countryCode)) : null;
    if (!isConclusive(metrics)) {
      return { ...base, dataStatus: "inconclusive", inconclusiveReason: "no_performance_data", metrics: null, period, message: NO_PERFORMANCE_DATA };
    }
    return { ...base, dataStatus: "ok", metrics, period };
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
      const report = await this.loadReport<CampaignReportRow>(status.profileId, "campaigns");
      if (!report) {
        return { dataStatus: "inconclusive", inconclusiveReason: "no_performance_data", profileId: status.profileId, campaigns, message: NO_PERFORMANCE_DATA };
      }
      const rowsById = groupBy(report.rows, (r) => String(r.campaignId ?? ""));
      return {
        dataStatus: "ok",
        profileId: status.profileId,
        // A campaign missing from a stored report had no activity in its window: real zeros.
        campaigns: campaigns.map((c) => ({ ...c, metrics: toAdMetrics(rowsById.get(c.campaignId) ?? []) })),
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

  /** Proceso 1: profit after ads per SKU from the advertised-products report and the margins snapshot. */
  async getProfitability(): Promise<AdvertisingProfitabilityResponse> {
    const status = await this.getConnectionStatus();
    if (!status.isConnected || !status.profileId) {
      return { dataStatus: "inconclusive", inconclusiveReason: status.isConfigured ? "connection_error" : "not_configured", skus: [], error: status.error };
    }
    const profileId = status.profileId;
    try {
      const report = await this.loadReport<AdvertisedProductReportRow>(profileId, "advertisedProducts");
      if (!report) return { dataStatus: "inconclusive", inconclusiveReason: "no_performance_data", profileId, skus: [], message: NO_PERFORMANCE_DATA };
      const { skus, totals } = computeProfitability(report.rows, await this.loadMargins(profileId));
      const meta = { profileId, period: { start: report.startDate, end: report.endDate }, reportGeneratedAt: report.generatedAt, totals, skus };
      if (totals.spend <= 0) return { ...meta, dataStatus: "inconclusive", inconclusiveReason: "no_performance_data", message: NO_PERFORMANCE_DATA };
      if (!totals.coverageOk) {
        const pct = Math.round(totals.costCoverage * 100);
        return {
          ...meta,
          dataStatus: "inconclusive",
          inconclusiveReason: "low_cost_coverage",
          message: `Solo el ${pct} % del gasto tiene coste de producto (mínimo 90 %): no se decide sobre estos datos.`,
        };
      }
      return { ...meta, dataStatus: "ok" };
    } catch (err) {
      return { dataStatus: "inconclusive", inconclusiveReason: "connection_error", profileId, skus: [], error: this.logged(toErrorInfo(err)) };
    }
  }

  private async loadReport<T>(profileId: string, kind: AdsReportKind): Promise<StoredAdsReport<T> | null> {
    return this.deps.reports ? this.deps.reports.load<T>(profileId, kind) : null;
  }

  /** Margins built for the advertised SKUs (ads:margins) win over the active-FBA margins:products snapshot. */
  private async loadMargins(profileId: string): Promise<MarginInput[]> {
    type Item = { sku: string; price: number | null; fees?: { total: number | null }; landedCost: number | null; cost?: { vatRate: number | null } };
    const store = this.deps.reports;
    if (!store) return [];
    const [adMargins, products] = await Promise.all([
      store.readSnapshot<AdMarginsSnapshot>(adsMarginsKey(profileId)),
      store.readSnapshot<{ items?: Item[] }>(MARGINS_SNAPSHOT_KEY),
    ]);
    const fromProducts: MarginInput[] = (products?.items ?? []).map((i) => ({
      sku: i.sku,
      price: i.price,
      feesTotal: i.fees?.total ?? null,
      landedCost: i.landedCost,
      vatRate: i.cost?.vatRate ?? null,
    }));
    const bySku = new Map(fromProducts.map((m) => [m.sku.toUpperCase(), m]));
    for (const m of adMargins?.items ?? []) {
      if (unitProfitBeforeAds(m) !== null || !bySku.has(m.sku.toUpperCase())) bySku.set(m.sku.toUpperCase(), m);
    }
    return [...bySku.values()];
  }

  /** TACoS denominator; a failure leaves TACoS null (logged), it is never estimated. */
  private async channelSales(period: { start: string; end: string }, countryCode?: string): Promise<number | null> {
    const channel = salesChannelFor(countryCode);
    if (!channel || !this.deps.storeSales) return null;
    try {
      return await this.deps.storeSales(period.start, period.end, channel);
    } catch (err) {
      this.logged({ kind: "client", message: `Ventas de ${channel} no disponibles para TACoS: ${err instanceof Error ? err.message : String(err)}` });
      return null;
    }
  }

  /** Configured profile must be one Amazon authorized; otherwise pick the one selling in our marketplace — never "the first". */
  private resolveProfile(profiles: AdsProfile[]): AdsProfile | undefined {
    if (this.configuredProfileId) {
      return profiles.find((p) => String(p.profileId) === this.configuredProfileId);
    }
    return profiles.find((p) => p.accountInfo?.marketplaceStringId === this.marketplaceId);
  }

  private inconclusiveSummary(status: AdsConnectionStatus): AdvertisingSummary {
    return {
      dataStatus: "inconclusive",
      inconclusiveReason: status.isConfigured ? "connection_error" : "not_configured",
      isConnected: false,
      profileId: status.profileId,
      totalCampaigns: 0,
      activeCampaigns: 0,
      metrics: null,
      period: this.emptyPeriod(),
      message: status.error?.message,
      error: status.error,
    };
  }

  private emptyPeriod(): AdvertisingSummary["period"] {
    const today = new Date().toISOString().slice(0, 10);
    return { start: today, end: today };
  }

  /** Spec §5: no silent failures — every Ads error is logged with its kind. */
  private logged(error: AdsErrorInfo): AdsErrorInfo {
    console.warn(`[advertising] ${error.kind}: ${error.message}`);
    return error;
  }
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
  return map;
}
