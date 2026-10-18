import { describe, expect, it, vi } from "vitest";
import { type AdsApiClient, AdsApiError } from "../../ads/adsClient";
import type { AdCampaign, AdsProfile } from "../../ads/types";
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
  const zero = { spend: 0, attributedSales: 0, totalStoreSales: 0, clicks: 0, impressions: 0, cpc: 0, ctr: 0, acos: 0, roas: 0, tacos: 0 };
  it("treats null and all-zero metrics as inconclusive", () => {
    expect(isConclusive(null)).toBe(false);
    expect(isConclusive(zero)).toBe(false);
    expect(isConclusive({ ...zero, impressions: 10 })).toBe(true);
  });
});
