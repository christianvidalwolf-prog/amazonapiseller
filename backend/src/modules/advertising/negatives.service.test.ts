import { describe, expect, it } from "vitest";
import type { AdsReportStore } from "./adsReports.store";
import type { AdvertisingService } from "./advertising.service";
import { DecisionError, keywordDecisionsKey, NegativesService } from "./negatives.service";

const advertising = { getConnectionStatus: async () => ({ isConfigured: true, isConnected: true, profileId: "P1" }) } as unknown as AdvertisingService;
const window = { profileId: "P1", startDate: "2026-09-16", endDate: "2026-10-15", generatedAt: "2026-10-18T06:00:00Z" };

function memoryStore() {
  const snapshots: Record<string, unknown> = {
    "margins:products": { items: [{ sku: "A", price: 12.1, fees: { total: 3 }, landedCost: 2, cost: { vatRate: 21 } }] },
  };
  const reports: Record<string, unknown[]> = {
    searchTerms: [{ searchTerm: "cuarzo gratis", campaignId: "C1", adGroupId: "G1", clicks: 30, cost: 9, purchases7d: 0 }],
    advertisedProducts: [{ advertisedSku: "A", adGroupId: "G1", clicks: 100, purchases7d: 10 }],
  };
  const store: AdsReportStore = {
    load: async (_p, kind) => (reports[kind] ? ({ ...window, kind, rows: reports[kind] } as never) : null),
    save: async () => undefined,
    readSnapshot: async (key) => (snapshots[key] ?? null) as never,
    writeSnapshot: async (key, data) => {
      snapshots[key] = data;
    },
  };
  return { store, snapshots };
}

describe("NegativesService", () => {
  it("returns the leak report and proposals for the report window", async () => {
    const res = await new NegativesService(advertising, memoryStore().store).getKeywordHarvest();
    expect(res).toMatchObject({ dataStatus: "ok", profileId: "P1", period: { start: "2026-09-16", end: "2026-10-15" } });
    expect(res.negatives?.proposals.map((p) => [p.text, p.status])).toEqual([["cuarzo gratis", "proposed"]]);
  });

  it("records a decision with its timestamp and keeps it on the next read", async () => {
    const { store, snapshots } = memoryStore();
    const svc = new NegativesService(advertising, store);
    const id = "G1|NEGATIVE_EXACT|cuarzo gratis";
    const decided = await svc.decide(id, "approved", undefined, new Date("2026-10-18T12:00:00Z"));
    expect(decided).toMatchObject({ status: "approved", decidedAt: "2026-10-18T12:00:00.000Z" });
    expect(snapshots[keywordDecisionsKey("P1")]).toEqual({ [id]: { decision: "approved", decidedAt: "2026-10-18T12:00:00.000Z" } });
    expect((await svc.getKeywordHarvest()).negatives?.proposals[0].status).toBe("approved");
  });

  it("refuses decisions on unknown proposals", async () => {
    const err = await new NegativesService(advertising, memoryStore().store).decide("nope", "approved").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecisionError);
    expect((err as DecisionError).statusCode).toBe(404);
  });

  it("writes a Change Log entry with baseline and review date, and lists it", async () => {
    const { store, snapshots } = memoryStore();
    const svc = new NegativesService(advertising, store);
    await svc.decide("G1|NEGATIVE_EXACT|cuarzo gratis", "approved", undefined, new Date("2026-10-18T12:00:00Z"));
    const log = snapshots["ads:changelog:P1"] as Array<Record<string, unknown>>;
    expect(log[0]).toMatchObject({ entityId: "G1|NEGATIVE_EXACT|cuarzo gratis", action: "approved", reviewDate: "2026-11-01", baselineMetric: "30 clics, 9 € gasto, 0 ventas" });
    expect((await svc.getChangeLog()).entries).toHaveLength(1);
    const harvest = await svc.getKeywordHarvest(undefined, new Date("2026-10-20T00:00:00Z"));
    expect(harvest.negatives?.proposals[0]).toMatchObject({ status: "approved", maturingUntil: "2026-11-01" });
  });
});

