import { describe, expect, it } from "vitest";
import type { SearchQueryMetrics } from "../brand-analytics/searchFunnel.types";
import { checkCopy, type Experiment, judge, pickCandidates } from "./listingCopy";

const m = (over: Partial<SearchQueryMetrics>): SearchQueryMetrics => ({
  queryText: "cesta mimbre",
  asin: "B0CESTA001",
  periodStart: "2026-10-01",
  periodEnd: "2026-10-07",
  totalQueryVolume: 500,
  totalImpressions: 5000,
  totalClicks: 300,
  totalCartAdds: 60,
  totalPurchases: 30,
  medianPrice: 15,
  asinMedianPrice: 15,
  currency: "EUR",
  asinImpressions: 500,
  asinImpressionShare: 0.1,
  asinClicks: 30,
  asinClickShare: 0.1,
  asinCartAdds: 6,
  asinCartAddShare: 0.1,
  asinPurchases: 3,
  asinPurchaseShare: 0.1,
  ...over,
});

const bullets = ["Material natural de mimbre trenzado a mano", "Medidas 30 x 20 cm", "Ideal para regalo"];

describe("listing copy agent", () => {
  it("accepts a clean proposal and rejects promo words, prices, missing brand and long titles", () => {
    expect(checkCopy("ROCKING GIFTS Cesta de mimbre natural 30 cm", bullets)).toEqual([]);
    expect(checkCopy("Cesta de mimbre", bullets).join()).toMatch(/empezar por/);
    expect(checkCopy("ROCKING GIFTS Cesta oferta", bullets).join()).toMatch(/oferta/);
    expect(checkCopy("ROCKING GIFTS Cesta", ["Solo 9,99 €", ...bullets]).join()).toMatch(/precio/);
    expect(checkCopy(`ROCKING GIFTS ${"x".repeat(200)}`, bullets).join()).toMatch(/caracteres/);
  });

  it("picks a brand ASIN whose converting search is missing from the copy, and skips cooldowns", () => {
    const rows = [m({}), m({ periodStart: "2026-10-08" })];
    const copy = new Map([["B0CESTA001", "ROCKING GIFTS Cesto natural"]]);
    const now = new Date("2026-11-15");
    expect(pickCandidates(rows, new Set(["B0CESTA001"]), copy, { experiments: [] }, now, 3).map((c) => c.asin)).toEqual(["B0CESTA001"]);
    const recent = { asin: "B0CESTA001", appliedAt: "2026-11-01T00:00:00Z", status: "kept" } as Experiment;
    expect(pickCandidates(rows, new Set(["B0CESTA001"]), copy, { experiments: [recent] }, now, 3)).toEqual([]);
    expect(pickCandidates(rows, new Set(), copy, { experiments: [] }, now, 3)).toEqual([]);
  });

  it("reverts when purchases per impression drop more than 15 % after 28 days", () => {
    const e = { asin: "B0CESTA001", appliedAt: "2026-10-15T09:00:00Z", status: "running" } as Experiment;
    const before = [m({ periodStart: "2026-09-20" }), m({ periodStart: "2026-10-01" })];
    const worse = [...before, m({ periodStart: "2026-10-20", asinPurchases: 1 }), m({ periodStart: "2026-10-27", asinPurchases: 1 })];
    const better = [...before, m({ periodStart: "2026-10-20", asinPurchases: 4 }), m({ periodStart: "2026-10-27" })];
    expect(judge(worse, e, new Date("2026-11-01")).action).toBe("wait");
    expect(judge(worse, e, new Date("2026-11-13")).action).toBe("revert");
    expect(judge(better, e, new Date("2026-11-13")).action).toBe("keep");
  });
});
