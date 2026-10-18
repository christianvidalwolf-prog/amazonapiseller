import { describe, expect, it } from "vitest";
import { buildCountryAudit } from "./audit";

describe("buildCountryAudit", () => {
  it("renders the 5 sections and Change Log rows with a review date 14 days ahead", () => {
    const { markdown, changes } = buildCountryAudit(
      {
        country: "ES",
        summary: {
          dataStatus: "ok",
          isConnected: true,
          totalCampaigns: 2,
          activeCampaigns: 2,
          metrics: { spend: 10, attributedSales: 40, totalStoreSales: 400, clicks: 50, impressions: 1000, orders: 3, cpc: 0.2, ctr: 5, acos: 25, roas: 4, tacos: 2.5 },
          period: { start: "2026-09-16", end: "2026-10-15" },
        },
        campaigns: [{ campaignId: "c", name: "Muerta", campaignType: "sponsoredProducts", state: "enabled", dailyBudget: 5, metrics: { impressions: 0, clicks: 0, cost: 0, sales: 0, orders: 0, cpc: 0, ctr: 0, acos: 0, roas: 0 } }],
        profitability: {
          dataStatus: "ok",
          contextAvailable: true,
          alerts: [{ sku: "A", asin: "B0", flags: ["SIN_BUY_BOX"], spend: 6, woc: null }],
          skus: [
            { sku: "A", asin: "B0", spend: 6, clicks: 30, impressions: 900, adSales: 0, adOrders: 0, sameSkuUnits: 0, sameSkuSales: 0, acos: null, price: 12.1, unitProfitBeforeAds: 5, breakEvenAcos: 41.32, profitAfterAds: -6, verdict: "leak", returnRate: null, alpha: 0, flags: ["SIN_BUY_BOX"], woc: null, buyBox: false, targetAcos: 26.86, cpc: 0.2, maxCpc: null, suggestedCpc: 0, bidAction: "pausar", bidReason: "Sin Buy Box o sin stock: no anunciar" },
          ],
        },
        keywords: { dataStatus: "ok", harvest: [] },
      },
      "2026-10-18"
    );
    for (const h of ["### 1.", "### 2.", "### 3.", "### 4.", "### 5."]) expect(markdown).toContain(h);
    expect(markdown).toContain("Muerta");
    expect(markdown).toContain("SIN_BUY_BOX");
    expect(changes).toEqual([expect.objectContaining({ sku: "A", action: "Pausar anuncio" })]);
    expect(markdown).toContain("2026-11-01");
  });
});
