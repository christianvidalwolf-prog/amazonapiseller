import { describe, expect, it } from "vitest";
import { type AdsApiClient, AdsApiError, type AdsReportStatus } from "../../ads/adsClient";
import type { AdsReportStore, StoredAdsReport } from "./adsReports.store";
import { syncAdsReports } from "./adsReports.sync";

function memoryStore() {
  const saved: StoredAdsReport[] = [];
  const store: AdsReportStore = {
    load: async () => null,
    readSnapshot: async () => null,
    writeSnapshot: async () => undefined,
    save: async (r) => {
      saved.push(r as StoredAdsReport);
    },
  };
  return { store, saved };
}

/** Amazon stand-in: campaigns completes on the 2nd poll, searchTerms fails, advertisedProducts never finishes. */
function fakeAds() {
  const polls = new Map<string, number>();
  return {
    createReport: async (_p: string, req: { configuration: { reportTypeId: string } }) => {
      if (req.configuration.reportTypeId === "spSearchTerm") throw new AdsApiError(400, "bad column");
      return req.configuration.reportTypeId;
    },
    getReport: async (_p: string, id: string): Promise<AdsReportStatus> => {
      const n = (polls.get(id) ?? 0) + 1;
      polls.set(id, n);
      if (id === "spCampaigns" && n >= 2) return { reportId: id, status: "COMPLETED", url: "https://s3/x" };
      return { reportId: id, status: "PROCESSING" };
    },
    downloadReport: async () => [{ campaignId: 1, cost: 2 }],
  } as unknown as AdsApiClient;
}

describe("syncAdsReports", () => {
  it("stores completed reports with their window and reports every failure", async () => {
    const { store, saved } = memoryStore();
    const results = await syncAdsReports(fakeAds(), store, "123", {
      now: new Date("2026-10-18T10:00:00Z"),
      pollMs: 1,
      maxWaitMs: 5,
      sleep: async () => undefined,
    });
    expect(Object.fromEntries(results.map((r) => [r.kind, r.status]))).toEqual({
      campaigns: "saved",
      advertisedProducts: "timeout",
      searchTerms: "failed",
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ profileId: "123", kind: "campaigns", startDate: "2026-09-16", endDate: "2026-10-15", rows: [{ campaignId: 1, cost: 2 }] });
  });
});
