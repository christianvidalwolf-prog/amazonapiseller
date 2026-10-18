import { describe, expect, it } from "vitest";
import { reportWindow } from "../../ads/reportTypes";
import { computeProfitability, type MarginInput, unitProfitBeforeAds } from "./profitability";

// 12,10 € incl. 21 % VAT → 10 € net; fees 3 €, landed cost 2 € → 5 € profit per unit before ads.
const margin = (sku: string, over: Partial<MarginInput> = {}): MarginInput => ({ sku, price: 12.1, feesTotal: 3, landedCost: 2, vatRate: 21, ...over });

describe("unitProfitBeforeAds", () => {
  it("removes VAT before fees and landed cost", () => {
    expect(unitProfitBeforeAds(margin("A"))).toBe(5);
  });
  it("defaults to 21 % VAT and refuses incomplete margins", () => {
    expect(unitProfitBeforeAds(margin("A", { vatRate: null }))).toBe(5);
    expect(unitProfitBeforeAds(margin("A", { landedCost: null }))).toBeNull();
    expect(unitProfitBeforeAds(undefined)).toBeNull();
  });
});

describe("computeProfitability", () => {
  const rows = [
    // A: two campaigns, 4 own units × 5 € = 20 € vs 12 € spend → +8 €
    { advertisedSku: "A", advertisedAsin: "B0A", cost: 7, sales7d: 40, purchases7d: 3, unitsSoldSameSku7d: 3, attributedSalesSameSku7d: 36.3 },
    { advertisedSku: "A", cost: 5, sales7d: 12.1, purchases7d: 1, unitsSoldSameSku7d: 1, attributedSalesSameSku7d: 12.1 },
    // B: halo-only sales do not count → 0 × 5 − 9 = −9 € (leak)
    { advertisedSku: "B", advertisedAsin: "B0B", cost: 9, sales7d: 30, purchases7d: 2, unitsSoldSameSku7d: 0 },
    // C: no margin known → excluded
    { advertisedSku: "C", advertisedAsin: "B0C", cost: 1, sales7d: 0 },
  ];

  it("computes profit after ads, break-even ACoS and verdicts per SKU", () => {
    const { skus } = computeProfitability(rows, [margin("a"), margin("B")]);
    const bySku = Object.fromEntries(skus.map((s) => [s.sku, s]));
    expect(bySku.A).toMatchObject({ spend: 12, sameSkuUnits: 4, profitAfterAds: 8, verdict: "profitable", breakEvenAcos: 41.32 });
    expect(bySku.B).toMatchObject({ profitAfterAds: -9, verdict: "leak" });
    expect(bySku.C).toMatchObject({ verdict: "no_cost", profitAfterAds: null });
    expect(skus[0].sku).toBe("B"); // worst first
  });

  it("totals coverage and leaks; under 90 % covered spend is not decidable", () => {
    const { totals } = computeProfitability(rows, [margin("A"), margin("B")]);
    expect(totals).toMatchObject({ spend: 22, spendWithCost: 21, leakSkus: 1, leakSpend: 9, leakLoss: -9, profitAfterAds: -1 });
    expect(totals.costCoverage).toBeCloseTo(0.955, 3);
    expect(totals.coverageOk).toBe(true);
    expect(computeProfitability(rows, [margin("B")]).totals.coverageOk).toBe(false);
  });
});

describe("reportWindow", () => {
  it("spans 30 days ending 3 days before today (reports lag ~72 h)", () => {
    expect(reportWindow(new Date("2026-10-18T10:00:00Z"))).toEqual({ startDate: "2026-09-16", endDate: "2026-10-15" });
  });

  it("marks SKUs with neither spend nor own units as idle, not profitable", () => {
    const { skus } = computeProfitability([{ advertisedSku: "A", impressions: 40, cost: 0 }], [margin("A")]);
    expect(skus[0]).toMatchObject({ verdict: "idle", profitAfterAds: 0 });
  });
});

