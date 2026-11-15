import { describe, expect, it } from "vitest";
import { type AdsTermStats, aggregateWeeks, buildInsights, confirmedCuts, recommend, trends } from "./funnelInsights";
import type { SearchQueryMetrics } from "./searchFunnel.types";

const m = (over: Partial<SearchQueryMetrics>): SearchQueryMetrics => ({
  queryText: "salero",
  asin: "B0SALERO01",
  periodStart: "2026-11-01",
  periodEnd: "2026-11-07",
  totalQueryVolume: 300,
  totalImpressions: 3000,
  totalClicks: 200,
  totalCartAdds: 40,
  totalPurchases: 20,
  medianPrice: 15,
  asinMedianPrice: 17.5,
  currency: "EUR",
  asinImpressions: 300,
  asinImpressionShare: 0.1,
  asinClicks: 20,
  asinClickShare: 0.1,
  asinCartAdds: 6,
  asinCartAddShare: 0.15,
  asinPurchases: 3,
  asinPurchaseShare: 0.15,
  ...over,
});
const ads = (over: Partial<AdsTermStats> = {}) => new Map([["salero", { spend: 1, sales: 30, clicks: 5, orders: 2, exactLive: false, ...over }]]);

describe("funnel insights", () => {
  it("adds weeks up and recomputes shares", () => {
    const [a] = aggregateWeeks([m({}), m({ periodStart: "2026-11-08", asinPurchases: 1, totalPurchases: 20 })]);
    expect(a.weeks).toBe(2);
    expect(a.asinPurchases).toBe(4);
    expect(a.asinPurchaseShare).toBe(0.1);
  });

  it("recommends scaling a converting term not yet exact, and nothing when it already is", () => {
    const rows = [m({}), m({ periodStart: "2026-11-08" })];
    expect(recommend(buildInsights(rows, ads())).filter((r) => r.kind === "scale").map((r) => r.term)).toEqual(["salero"]);
    expect(recommend(buildInsights(rows, ads({ exactLive: true }))).filter((r) => r.kind === "scale")).toEqual([]);
  });

  it("flags the earliest listing leak of an ASIN against the market rates", () => {
    const rows = [0, 7].map((d) => m({ periodStart: `2026-11-0${1 + d}`, asinClicks: 20, asinCartAdds: 0, asinCartAddShare: 0, asinPurchases: 0, asinPurchaseShare: 0 }));
    const listing = recommend(buildInsights(rows, new Map()), rows).filter((r) => r.kind === "listing" && r.term.startsWith("("));
    expect(listing).toHaveLength(1);
    expect(listing[0].action).toMatch(/carrito/); // CTR ok (40/600 vs 400/6000), cart 0 % vs market 20 %
  });

  it("sends a single organic purchase that converts above its click share to FRASE", () => {
    const rec = recommend(buildInsights([m({ asinPurchases: 1, totalPurchases: 5 })], new Map()));
    expect(rec.filter((r) => r.kind === "scale").map((r) => r.to)).toEqual(["phrase"]);
  });

  it("cuts only with both signals: Ads pays without sales and SQP shows clicks without purchases", () => {
    const rows = [m({ asinClicks: 12, asinPurchases: 0, asinPurchaseShare: 0 })];
    expect(confirmedCuts(rows, ads({ spend: 3, sales: 0 })).map((r) => r.term)).toEqual(["salero"]);
    expect(confirmedCuts([m({})], ads({ spend: 3, sales: 0 }))).toEqual([]); // SQP has purchases
    expect(confirmedCuts(rows, ads({ spend: 1, sales: 0 }))).toEqual([]); // not enough Ads spend
  });

  it("compares the last week's purchase share with the previous ones", () => {
    const t = trends([m({}), m({ periodStart: "2026-11-08", asinPurchases: 1, asinPurchaseShare: 0.05 })]);
    expect(t).toEqual([{ asin: "B0SALERO01", term: "salero", previousShare: 0.15, lastShare: 0.05 }]);
  });
});
