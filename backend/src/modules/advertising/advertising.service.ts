import type { AdsApiClient } from "../../ads/adsClient";
import type { AdCampaign, AdvertisingSummary, AdsProfile } from "../../ads/types";
import type { SalesService } from "../sales/sales.service";

export class AdvertisingService {
  constructor(
    private readonly adsClient: AdsApiClient,
    private readonly salesService: SalesService,
    private readonly marketplaceId: string,
    private readonly profileId?: string
  ) {}

  async getConnectionStatus(): Promise<{
    isConfigured: boolean;
    isConnected: boolean;
    profileId?: string;
    profiles?: AdsProfile[];
    error?: string;
  }> {
    if (!this.adsClient.isConfigured()) {
      return {
        isConfigured: false,
        isConnected: false,
        profileId: this.profileId,
        error: "Faltan credenciales de Amazon Ads en .env (ADS_API_REFRESH_TOKEN o ADS_API_CLIENT_ID).",
      };
    }

    try {
      const profiles = await this.adsClient.getProfiles();
      return {
        isConfigured: true,
        isConnected: true,
        profileId: this.profileId || (profiles.length > 0 ? String(profiles[0].profileId) : undefined),
        profiles,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isConfigured: true,
        isConnected: false,
        profileId: this.profileId,
        error: message,
      };
    }
  }

  async getProfiles(): Promise<AdsProfile[]> {
    return this.adsClient.getProfiles();
  }

  async getSummary(startDate?: string, endDate?: string): Promise<AdvertisingSummary> {
    const end = endDate || new Date().toISOString().slice(0, 10);
    const start = startDate || new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);

    // Fetch total store sales to compute TACoS
    let totalStoreSales = 0;
    try {
      const salesData = await this.salesService.getSalesSummary(
        `${start}T00:00:00Z`,
        `${end}T23:59:59Z`
      );
      totalStoreSales = salesData.totalRevenue || 0;
    } catch {
      totalStoreSales = 0;
    }

    // Try live Amazon Ads API
    const status = await this.getConnectionStatus();
    if (status.isConnected) {
      try {
        const campaigns = await this.adsClient.listSponsoredProductsCampaigns(this.profileId);
        let spend = 0;
        let attributedSales = 0;
        let clicks = 0;
        let impressions = 0;

        for (const c of campaigns) {
          spend += c.metrics.cost;
          attributedSales += c.metrics.sales;
          clicks += c.metrics.clicks;
          impressions += c.metrics.impressions;
        }

        const cpc = clicks > 0 ? spend / clicks : 0;
        const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
        const acos = attributedSales > 0 ? (spend / attributedSales) * 100 : 0;
        const roas = spend > 0 ? attributedSales / spend : 0;
        const effectiveStoreSales = Math.max(totalStoreSales, attributedSales);
        const tacos = effectiveStoreSales > 0 ? (spend / effectiveStoreSales) * 100 : 0;

        return {
          isConnected: true,
          profileId: this.profileId,
          marketplace: "Amazon.es",
          currency: "EUR",
          totalCampaigns: campaigns.length,
          activeCampaigns: campaigns.filter((c) => c.state === "enabled").length,
          metrics: {
            spend: Number(spend.toFixed(2)),
            attributedSales: Number(attributedSales.toFixed(2)),
            totalStoreSales: Number(effectiveStoreSales.toFixed(2)),
            clicks,
            impressions,
            cpc: Number(cpc.toFixed(2)),
            ctr: Number(ctr.toFixed(2)),
            acos: Number(acos.toFixed(2)),
            roas: Number(roas.toFixed(2)),
            tacos: Number(tacos.toFixed(2)),
          },
          period: { start, end },
          isDemoData: false,
        };
      } catch {
        // Fallback to demo data below if live fetch fails
      }
    }

    // Fallback: Demo / Realistic data based on actual store sales
    return this.getSimulatedSummary(totalStoreSales, start, end, status.error);
  }

  async getCampaigns(): Promise<AdCampaign[]> {
    const status = await this.getConnectionStatus();
    if (status.isConnected) {
      try {
        return await this.adsClient.listSponsoredProductsCampaigns(this.profileId);
      } catch {
        // Fall through to mock campaigns
      }
    }

    return this.getSimulatedCampaigns();
  }

  private getSimulatedSummary(
    storeRevenue: number,
    start: string,
    end: string,
    errorMessage?: string
  ): AdvertisingSummary {
    const revenue = storeRevenue > 0 ? storeRevenue : 14250.0;
    // Standard healthy PPC proportion: ~25-30% of sales from PPC, ~18% ACoS, ~5% TACoS
    const attributedSales = Number((revenue * 0.28).toFixed(2));
    const spend = Number((attributedSales * 0.19).toFixed(2)); // ~19% ACoS
    const clicks = Math.round(spend / 0.42); // ~0.42€ CPC
    const impressions = clicks * 75; // ~1.33% CTR
    const cpc = clicks > 0 ? spend / clicks : 0.42;
    const ctr = impressions > 0 ? (clicks / impressions) * 100 : 1.33;
    const acos = (spend / attributedSales) * 100;
    const roas = attributedSales / spend;
    const tacos = (spend / revenue) * 100;

    return {
      isConnected: false,
      profileId: this.profileId || "2948104829048",
      marketplace: "Amazon.es",
      currency: "EUR",
      totalCampaigns: 6,
      activeCampaigns: 5,
      metrics: {
        spend: Number(spend.toFixed(2)),
        attributedSales: Number(attributedSales.toFixed(2)),
        totalStoreSales: Number(revenue.toFixed(2)),
        clicks,
        impressions,
        cpc: Number(cpc.toFixed(2)),
        ctr: Number(ctr.toFixed(2)),
        acos: Number(acos.toFixed(2)),
        roas: Number(roas.toFixed(2)),
        tacos: Number(tacos.toFixed(2)),
      },
      period: { start, end },
      isDemoData: true,
      message: errorMessage || "Amazon Ads API pendiente de vincular (ejecuta scripts/ads_auth_helper.py).",
    };
  }

  private getSimulatedCampaigns(): AdCampaign[] {
    return [
      {
        campaignId: "sp_camp_001",
        name: "SP - Top Sellers - Exacta Manual",
        campaignType: "sponsoredProducts",
        targetingType: "manual",
        state: "enabled",
        dailyBudget: 25.0,
        startDate: "2026-01-01",
        metrics: {
          impressions: 48200,
          clicks: 650,
          cost: 265.5,
          sales: 1780.0,
          orders: 68,
          cpc: 0.41,
          ctr: 1.35,
          acos: 14.92,
          roas: 6.7,
        },
      },
      {
        campaignId: "sp_camp_002",
        name: "SP - Categoría Regalos - Auto Broad",
        campaignType: "sponsoredProducts",
        targetingType: "auto",
        state: "enabled",
        dailyBudget: 15.0,
        startDate: "2026-01-15",
        metrics: {
          impressions: 32400,
          clicks: 410,
          cost: 155.8,
          sales: 790.0,
          orders: 31,
          cpc: 0.38,
          ctr: 1.27,
          acos: 19.72,
          roas: 5.07,
        },
      },
      {
        campaignId: "sp_camp_003",
        name: "SP - Competidores Directos - ASIN Target",
        campaignType: "sponsoredProducts",
        targetingType: "manual",
        state: "enabled",
        dailyBudget: 20.0,
        startDate: "2026-02-01",
        metrics: {
          impressions: 21500,
          clicks: 290,
          cost: 142.1,
          sales: 620.0,
          orders: 22,
          cpc: 0.49,
          ctr: 1.35,
          acos: 22.92,
          roas: 4.36,
        },
      },
      {
        campaignId: "sb_camp_004",
        name: "SB - Marca Rocking Gifts - Video Ads",
        campaignType: "sponsoredBrands",
        targetingType: "manual",
        state: "enabled",
        dailyBudget: 30.0,
        startDate: "2026-01-10",
        metrics: {
          impressions: 54100,
          clicks: 520,
          cost: 218.4,
          sales: 1150.0,
          orders: 45,
          cpc: 0.42,
          ctr: 0.96,
          acos: 18.99,
          roas: 5.27,
        },
      },
      {
        campaignId: "sd_camp_005",
        name: "SD - Retargeting Visitas 30 días",
        campaignType: "sponsoredDisplay",
        targetingType: "manual",
        state: "enabled",
        dailyBudget: 12.0,
        startDate: "2026-02-15",
        metrics: {
          impressions: 18900,
          clicks: 165,
          cost: 74.25,
          sales: 340.0,
          orders: 14,
          cpc: 0.45,
          ctr: 0.87,
          acos: 21.84,
          roas: 4.58,
        },
      },
      {
        campaignId: "sp_camp_006",
        name: "SP - Test Nuevos Productos Q1",
        campaignType: "sponsoredProducts",
        targetingType: "auto",
        state: "paused",
        dailyBudget: 10.0,
        startDate: "2026-01-20",
        metrics: {
          impressions: 6200,
          clicks: 45,
          cost: 21.15,
          sales: 65.0,
          orders: 2,
          cpc: 0.47,
          ctr: 0.73,
          acos: 32.54,
          roas: 3.07,
        },
      },
    ];
  }
}
