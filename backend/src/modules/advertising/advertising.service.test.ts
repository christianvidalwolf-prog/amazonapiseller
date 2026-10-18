import { describe, expect, it, vi } from "vitest";
import { type AdsApiClient, AdsApiError } from "../../ads/adsClient";
import type { AdCampaign, AdsProfile } from "../../ads/types";
import type { AdsReportStore } from "./adsReports.store";
import { AdvertisingService, isConclusive } from "./advertising.service";

const ES = "A1RKKUPIHCS9HS";
const DE = "A1PA6795UKMFR9";

const profile = (profileId: number, countryCode: string, marketplaceStringId: string): AdsProfile => ({
  profileId,
  countryCode,
  currencyCode: "EUR",
  timezone: "Europe/Paris",
  accountInfo: { marketplaceStringId, type: "seller", name: "Zeller" },
});
const PROFILES = [profile(1, "DE", DE), profile(2, "ES", ES)];
const campaign = (id: string, state: AdCampaign["state"]): AdCampaign => ({
  campaignId: id,
  name: id,
  campaignType: "sponsoredProducts",
  state,
  dailyBudget: 10,
  metrics: null,
});

function fakeClient(overrides: Partial<Record<"isConfigured" | "getProfiles" | "listSponsoredProductsCampaigns", unknown>> = {}) {
  return {
    isConfigured: () => true,
    getProfiles: vi.fn(async () => PROFILES),
    listSponsoredProductsCampaigns: vi.fn(async () => [campaign("a", "enabled"), campaign("b", "paused")]),
    ...overrides,
  } as unknown as AdsApiClient;
}

vi.spyOn(console, "warn").mockImplementation(() => undefined);

describe("AdvertisingService (spec §5: no demo, no zeros)", () => {
  it("is inconclusive without credentials and invents nothing", async () => {
    const summary = await new AdvertisingService(fakeClient({ isConfigured: () => false }), ES).getSummary();
    expect(summary).toMatchObject({ dataStatus: "inconclusive", inconclusiveReason: "not_configured", metrics: null });
    expect(summary.error?.kind).toBe("not_configured");
    expect(summary).not.toHaveProperty("isDemoData");
  });

  it("reports an auth failure as connection_error with kind auth", async () => {
    const client = fakeClient({ getProfiles: async () => Promise.reject(new AdsApiError(401, "unauthorized")) });
    const summary = await new AdvertisingService(client, ES).getSummary();
    expect(summary).toMatchObject({ dataStatus: "inconclusive", inconclusiveReason: "connection_error", isConnected: false, metrics: null });
    expect(summary.error?.kind).toBe("auth");
  });

  it("connected but without performance reports: real campaign counts, metrics stay null", async () => {
    const client = fakeClient();
    const summary = await new AdvertisingService(client, ES).getSummary();
    expect(summary).toMatchObject({
      dataStatus: "inconclusive",
      inconclusiveReason: "no_performance_data",
      isConnected: true,
      profileId: "2",
      marketplace: "ES",
      totalCampaigns: 2,
      activeCampaigns: 1,
      metrics: null,
    });
    expect(client.listSponsoredProductsCampaigns).toHaveBeenCalledWith("2");
  });

  it("picks the profile of the configured marketplace, not the first one", async () => {
    const status = await new AdvertisingService(fakeClient(), ES).getConnectionStatus();
    expect(status.profileId).toBe("2");
  });

  it("rejects a configured profile Amazon did not authorize", async () => {
    const status = await new AdvertisingService(fakeClient(), ES, "999").getConnectionStatus();
    expect(status.isConnected).toBe(false);
    expect(status.error?.message).toContain("999");
  });

  it("surfaces a campaigns failure instead of falling back to fake campaigns", async () => {
    const client = fakeClient({ listSponsoredProductsCampaigns: async () => Promise.reject(new AdsApiError(503, "down")) });
    const res = await new AdvertisingService(client, ES).getCampaigns();
    expect(res).toMatchObject({ dataStatus: "inconclusive", inconclusiveReason: "connection_error", campaigns: [] });
    expect(res.error?.kind).toBe("server");
  });
});

describe("isConclusive", () => {
  const zero = { spend: 0, attributedSales: 0, totalStoreSales: 0, clicks: 0, impressions: 0, orders: 0, cpc: 0, ctr: 0, acos: 0, roas: 0, tacos: 0 };
  it("treats null and all-zero metrics as inconclusive", () => {
    expect(isConclusive(null)).toBe(false);
    expect(isConclusive(zero)).toBe(false);
    expect(isConclusive({ ...zero, impressions: 10 })).toBe(true);
  });
});

describe("AdvertisingService with stored reports", () => {
  const window = { profileId: "2", startDate: "2026-09-16", endDate: "2026-10-15", generatedAt: "2026-10-18T06:00:00Z" };
  const store = (reports: Record<string, unknown[]>, margins?: unknown): AdsReportStore => ({
    load: async (_p, kind) => (reports[kind] ? ({ ...window, kind, rows: reports[kind] } as never) : null),
    readSnapshot: async () => (margins ?? null) as never,
    writeSnapshot: async () => undefined,
    save: async () => undefined,
  });

  it("summary uses the report window, real metrics and channel sales for TACoS", async () => {
    const storeSales = vi.fn(async () => 1000);
    const svc = new AdvertisingService(fakeClient(), ES, undefined, {
      reports: store({ campaigns: [{ campaignId: "a", impressions: 1000, clicks: 50, cost: 25, sales7d: 100, purchases7d: 4 }] }),
      storeSales,
    });
    const summary = await svc.getSummary();
    expect(summary).toMatchObject({ dataStatus: "ok", period: { start: "2026-09-16", end: "2026-10-15" } });
    expect(summary.metrics).toMatchObject({ spend: 25, attributedSales: 100, acos: 25, roas: 4, cpc: 0.5, ctr: 5, tacos: 2.5, totalStoreSales: 1000 });
    expect(storeSales).toHaveBeenCalledWith("2026-09-16", "2026-10-15", "Amazon.es");
  });

  it("an all-zero report stays inconclusive", async () => {
    const svc = new AdvertisingService(fakeClient(), ES, undefined, { reports: store({ campaigns: [{ campaignId: "a", cost: 0 }] }) });
    expect((await svc.getSummary()).dataStatus).toBe("inconclusive");
  });

  it("campaigns carry report metrics; campaigns absent from the report get real zeros", async () => {
    const svc = new AdvertisingService(fakeClient(), ES, undefined, { reports: store({ campaigns: [{ campaignId: "a", clicks: 10, cost: 4, sales7d: 16 }] }) });
    const res = await svc.getCampaigns();
    expect(res.dataStatus).toBe("ok");
    expect(res.campaigns.find((c) => c.campaignId === "a")?.metrics).toMatchObject({ clicks: 10, cost: 4, acos: 25 });
    expect(res.campaigns.find((c) => c.campaignId === "b")?.metrics).toMatchObject({ clicks: 0, cost: 0 });
  });

  it("profitability is inconclusive below 90 % cost coverage", async () => {
    const reports = { advertisedProducts: [{ advertisedSku: "A", cost: 5, unitsSoldSameSku7d: 2 }, { advertisedSku: "B", cost: 5 }] };
    const margins = { items: [{ sku: "A", price: 12.1, fees: { total: 3 }, landedCost: 2, cost: { vatRate: 21 } }] };
    const res = await new AdvertisingService(fakeClient(), ES, undefined, { reports: store(reports, margins) }).getProfitability();
    expect(res).toMatchObject({ dataStatus: "inconclusive", inconclusiveReason: "low_cost_coverage" });
    expect(res.totals?.costCoverage).toBe(0.5);
    expect(res.skus).toHaveLength(2);
  });

  it("margins built for advertised SKUs complete the coverage left by margins:products", async () => {
    const reports = { advertisedProducts: [{ advertisedSku: "A", cost: 5, unitsSoldSameSku7d: 2 }, { advertisedSku: "FBM1", cost: 5, unitsSoldSameSku7d: 1 }] };
    const snapshots: Record<string, unknown> = {
      "margins:products": { items: [{ sku: "A", price: 12.1, fees: { total: 3 }, landedCost: 2, cost: { vatRate: 21 } }] },
      "ads:margins:2": { items: [{ sku: "FBM1", price: 24.2, feesTotal: 4, landedCost: 6, vatRate: 21 }] },
    };
    const reportStore: AdsReportStore = {
      ...store(reports),
      readSnapshot: async (key) => (snapshots[key] ?? null) as never,
    };
    const res = await new AdvertisingService(fakeClient(), ES, undefined, { reports: reportStore }).getProfitability();
    expect(res.dataStatus).toBe("ok");
    expect(res.totals?.costCoverage).toBe(1);
    expect(res.skus.find((s) => s.sku === "FBM1")).toMatchObject({ unitProfitBeforeAds: 10, profitAfterAds: 5, verdict: "profitable" });
  });
});
