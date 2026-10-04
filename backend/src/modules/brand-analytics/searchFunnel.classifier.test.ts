import { describe, expect, it } from "vitest";
import { classifyFunnel, funnelLeak, sortByImpact, summarizeFunnel, toFunnelRow } from "./searchFunnel.classifier";
import type { SearchQueryMetrics } from "./searchFunnel.types";
import { chunkAsinsForReport, mergePeriods, parseSearchQueryPerformanceReport, reportPeriodRange } from "./searchQueryReport";

/** A healthy mid-volume term; each test overrides only what its rule looks at. */
function metrics(overrides: Partial<SearchQueryMetrics> = {}): SearchQueryMetrics {
  return {
    queryText: "cuarzo rosa",
    asin: "B0CV4CB3SY",
    periodStart: "2026-09-20",
    periodEnd: "2026-09-26",
    totalQueryVolume: 10_000,
    totalImpressions: 100_000,
    totalClicks: 4_000,
    totalCartAdds: 800,
    totalPurchases: 300,
    medianPrice: 19.9,
    asinMedianPrice: 21.5,
    currency: "EUR",
    asinImpressions: 10_000,
    asinImpressionShare: 0.1,
    asinClicks: 400,
    asinClickShare: 0.1,
    asinCartAdds: 80,
    asinCartAddShare: 0.1,
    asinPurchases: 30,
    asinPurchaseShare: 0.1,
    ...overrides,
  };
}

describe("classifyFunnel", () => {
  it("leaves a term that keeps its share through the funnel as NORMAL", () => {
    expect(classifyFunnel(metrics())).toBe("NORMAL");
  });

  it("flags a SERP leak when click share is under half the impression share", () => {
    expect(classifyFunnel(metrics({ asinClicks: 160, asinClickShare: 0.04 }))).toBe("DROP_IMPRESSIONS_TO_CLICKS");
    expect(classifyFunnel(metrics({ asinClicks: 200, asinClickShare: 0.05 }))).toBe("NORMAL");
  });

  it("needs 500 impressions before calling a SERP leak", () => {
    expect(classifyFunnel(metrics({ asinImpressions: 499, asinClicks: 5, asinClickShare: 0.001, asinCartAdds: 1, asinPurchases: 0 }))).toBe(
      "LOW_VOLUME"
    );
  });

  it("flags a detail-page leak when under 3.5% of 30+ clicks reach the cart", () => {
    expect(classifyFunnel(metrics({ asinCartAdds: 13 }))).toBe("DROP_CLICKS_TO_CART");
    expect(classifyFunnel(metrics({ asinCartAdds: 14 }))).not.toBe("DROP_CLICKS_TO_CART");
    expect(classifyFunnel(metrics({ asinImpressions: 400, asinClicks: 29, asinCartAdds: 0, asinPurchases: 0 }))).toBe("LOW_VOLUME");
  });

  it("flags a checkout leak when under 20% of 10+ cart adds are bought", () => {
    expect(classifyFunnel(metrics({ asinPurchases: 15 }))).toBe("DROP_CART_TO_PURCHASE");
    expect(classifyFunnel(metrics({ asinPurchases: 16 }))).toBe("NORMAL");
  });

  it("marks a WINNER at 20% purchase share with a 40% purchase rate", () => {
    expect(classifyFunnel(metrics({ asinPurchases: 60, asinPurchaseShare: 0.2 }))).toBe("WINNER");
    expect(classifyFunnel(metrics({ asinPurchases: 31, asinPurchaseShare: 0.2 }))).toBe("NORMAL");
    expect(classifyFunnel(metrics({ asinPurchases: 60, asinPurchaseShare: 0.19 }))).toBe("NORMAL");
  });

  it("reports the earliest leak when several stages fail", () => {
    expect(classifyFunnel(metrics({ asinClicks: 100, asinClickShare: 0.025, asinCartAdds: 2, asinPurchases: 0 }))).toBe(
      "DROP_IMPRESSIONS_TO_CLICKS"
    );
  });
});

describe("funnelLeak", () => {
  it("measures a SERP leak as the clicks the impression share should have earned", () => {
    const m = metrics({ asinClicks: 160, asinClickShare: 0.04 });
    // Expected 10% of 4,000 clicks = 400; got 160. 6 points of share on 10,000 searches.
    expect(funnelLeak(m, "DROP_IMPRESSIONS_TO_CLICKS")).toEqual({ lostUnits: 240, impactScore: 600 });
  });

  it("measures a detail-page leak against the market cart rate", () => {
    const m = metrics({ asinCartAdds: 10, asinCartAddShare: 0.0125 });
    // Market cart rate 800/4,000 = 20% → 80 expected, 10 actual.
    expect(funnelLeak(m, "DROP_CLICKS_TO_CART")).toEqual({ lostUnits: 70, impactScore: 875 });
  });

  it("scores nothing for terms without a leak", () => {
    expect(funnelLeak(metrics(), "NORMAL")).toEqual({ lostUnits: 0, impactScore: 0 });
  });
});

describe("summarizeFunnel / sortByImpact", () => {
  const rows = [
    toFunnelRow(metrics({ queryText: "normal" })),
    toFunnelRow(metrics({ queryText: "serp", asinClicks: 160, asinClickShare: 0.04 })),
    toFunnelRow(metrics({ queryText: "ficha", asinCartAdds: 10, asinCartAddShare: 0.0125 })),
    toFunnelRow(metrics({ queryText: "ganador", asinPurchases: 60, asinPurchaseShare: 0.2 })),
  ];

  it("counts each leak and adds up what it costs", () => {
    expect(summarizeFunnel(rows)).toEqual({
      totalQueries: 4,
      dropImpressionsToClicks: 1,
      dropClicksToCart: 1,
      dropCartToPurchase: 0,
      winners: 1,
      lostClicks: 240,
      lostCartAdds: 70,
      lostPurchases: 0,
    });
  });

  it("orders by impact, highest first", () => {
    expect(sortByImpact(rows).map((row) => row.queryText)).toEqual(["ganador", "ficha", "serp", "normal"]);
  });
});

describe("reportPeriodRange", () => {
  it("returns the last complete Sunday–Saturday week", () => {
    // 2026-10-03 is a Saturday: the week it closes is not complete yet.
    expect(reportPeriodRange("WEEK", new Date("2026-10-03T10:00:00Z"))).toEqual({ periodStart: "2026-09-20", periodEnd: "2026-09-26" });
    expect(reportPeriodRange("WEEK", new Date("2026-10-04T00:30:00Z"))).toEqual({ periodStart: "2026-09-27", periodEnd: "2026-10-03" });
    expect(reportPeriodRange("WEEK", new Date("2026-10-04T00:30:00Z"), 1)).toEqual({ periodStart: "2026-09-20", periodEnd: "2026-09-26" });
  });

  it("returns the previous calendar month, across a year boundary too", () => {
    expect(reportPeriodRange("MONTH", new Date("2026-10-03T10:00:00Z"))).toEqual({ periodStart: "2026-09-01", periodEnd: "2026-09-30" });
    expect(reportPeriodRange("MONTH", new Date("2026-01-15T10:00:00Z"))).toEqual({ periodStart: "2025-12-01", periodEnd: "2025-12-31" });
    expect(reportPeriodRange("MONTH", new Date("2026-03-31T10:00:00Z"), 1)).toEqual({ periodStart: "2026-01-01", periodEnd: "2026-01-31" });
  });
});

describe("chunkAsinsForReport", () => {
  it("keeps each space-separated batch within Amazon's 200 characters", () => {
    const asins = Array.from({ length: 40 }, (_, i) => `B0${String(i).padStart(8, "0")}`);
    const chunks = chunkAsinsForReport(asins);
    expect(chunks.map((chunk) => chunk.length)).toEqual([18, 18, 4]);
    expect(chunks.flat()).toEqual(asins);
    for (const chunk of chunks) expect(chunk.join(" ").length).toBeLessThanOrEqual(200);
  });
});

describe("parseSearchQueryPerformanceReport", () => {
  it("flattens dataByAsin and derives shares from the counts", () => {
    const body = JSON.stringify({
      dataByAsin: [
        {
          startDate: "2026-09-20",
          endDate: "2026-09-26",
          asin: "B0CV4CB3SY",
          searchQueryData: { searchQuery: "cuarzo rosa", searchQueryScore: 1, searchQueryVolume: 1200 },
          impressionData: { totalQueryImpressionCount: 20000, asinImpressionCount: 1000, asinImpressionShare: 5 },
          clickData: {
            totalClickCount: 500,
            asinClickCount: 10,
            totalMedianClickPrice: { amount: 18.5, currencyCode: "EUR" },
            asinMedianClickPrice: { amount: 22, currencyCode: "EUR" },
          },
          cartAddData: { totalCartAddCount: 100, asinCartAddCount: 2 },
          purchaseData: { totalPurchaseCount: 0, asinPurchaseCount: 0 },
        },
        { asin: "B0CV4CB3SY", searchQueryData: {} },
      ],
    });
    expect(parseSearchQueryPerformanceReport(body)).toEqual([
      {
        queryText: "cuarzo rosa",
        asin: "B0CV4CB3SY",
        periodStart: "2026-09-20",
        periodEnd: "2026-09-26",
        totalQueryVolume: 1200,
        totalImpressions: 20000,
        totalClicks: 500,
        totalCartAdds: 100,
        totalPurchases: 0,
        medianPrice: 18.5,
        asinMedianPrice: 22,
        currency: "EUR",
        asinImpressions: 1000,
        asinImpressionShare: 0.05,
        asinClicks: 10,
        asinClickShare: 0.02,
        asinCartAdds: 2,
        asinCartAddShare: 0.02,
        asinPurchases: 0,
        asinPurchaseShare: 0,
      },
    ]);
  });
});

describe("mergePeriods", () => {
  it("adds up the months of a term and recomputes shares from the sums", () => {
    const july = metrics({ periodStart: "2026-07-01", periodEnd: "2026-07-31", asinMedianPrice: 19 });
    const august = metrics({
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      totalImpressions: 300_000,
      asinImpressions: 10_000,
      asinPurchases: 90,
      asinMedianPrice: null,
    });
    const other = metrics({ queryText: "amatista", periodStart: "2026-08-01", periodEnd: "2026-08-31" });

    const merged = mergePeriods([august, other, july]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      queryText: "cuarzo rosa",
      periodStart: "2026-07-01",
      periodEnd: "2026-08-31",
      totalQueryVolume: 20_000,
      totalImpressions: 400_000,
      asinImpressions: 20_000,
      asinImpressionShare: 0.05,
      asinPurchases: 120,
      asinPurchaseShare: 0.2,
      // August has no ASIN price, so July's is kept.
      asinMedianPrice: 19,
    });
    expect(merged[1]).toEqual(other);
  });

  it("lets a term reach the sample size no single month had", () => {
    const month = (periodStart: string) =>
      metrics({ periodStart, asinImpressions: 200, asinImpressionShare: 0.002, asinClicks: 12, asinClickShare: 0.003, asinCartAdds: 0, asinCartAddShare: 0, asinPurchases: 0, asinPurchaseShare: 0 });
    const months = [month("2026-06-01"), month("2026-07-01"), month("2026-08-01")];
    expect(months.map(classifyFunnel)).toEqual(["LOW_VOLUME", "LOW_VOLUME", "LOW_VOLUME"]);
    expect(classifyFunnel(mergePeriods(months)[0])).toBe("DROP_CLICKS_TO_CART");
  });
});
