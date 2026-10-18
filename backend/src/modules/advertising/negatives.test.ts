import { describe, expect, it } from "vitest";
import { ALPHA, analyzeNegatives, PRIOR_CLICKS, withDecisions } from "./negatives";
import type { MarginInput } from "./profitability";

// 12,10 € incl. 21 % VAT, 3 € fees, 2 € landed → 5 € profit per unit.
const MARGINS: MarginInput[] = [{ sku: "A", price: 12.1, feesTotal: 3, landedCost: 2, vatRate: 21 }];

// Ad group G1 converts 10 % (100 clicks, 10 orders) on top of a 10 % account rate → smoothed 10 %.
const PRODUCTS = [{ advertisedSku: "A", adGroupId: "G1", clicks: 100, purchases7d: 10 }];

const term = (searchTerm: string, clicks: number, cost: number, purchases7d = 0, adGroupId = "G1") => ({
  searchTerm,
  campaignId: "C1",
  adGroupId,
  clicks,
  cost,
  purchases7d,
  impressions: clicks * 50,
});

describe("analyzeNegatives", () => {
  it("proposes only terms whose zero sales are unlikely by chance and that cost more than one unit's profit", () => {
    const rows = [
      term("cuarzo gratis", 30, 9), // 0.9^30 = 4.2 % < 5 %, 9 € > 5 € → negate
      term("cuarzo", 30, 4), // unlikely by chance but 4 € < 5 € → insufficient
      term("piedra", 10, 8), // 0.9^10 = 34.9 % → insufficient
      term("collar", 40, 12, 1), // has a sale → not a candidate
    ];
    const { proposals, insufficient, summary } = analyzeNegatives(rows, PRODUCTS, MARGINS);
    expect(proposals.map((p) => p.text)).toEqual(["cuarzo gratis"]);
    expect(proposals[0]).toMatchObject({ type: "NEGATIVE_EXACT", id: "G1|NEGATIVE_EXACT|cuarzo gratis", unitProfit: 5, spend: 9 });
    expect(proposals[0].pNoSale).toBeLessThan(ALPHA);
    expect(insufficient.map((p) => p.text).sort()).toEqual(["cuarzo", "piedra"]);
    expect(summary).toMatchObject({ zeroSaleTerms: 3, proposedSpend: 9, insufficientSpend: 12 });
  });

  it("aggregates the same term reached through several targets and treats ASIN searches as product targets", () => {
    const rows = [term("b0abc12345", 15, 5), term("B0ABC12345", 15, 5)];
    const { proposals } = analyzeNegatives(rows, PRODUCTS, MARGINS);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ type: "NEGATIVE_PRODUCT_TARGET", text: "B0ABC12345", clicks: 30, spend: 10 });
  });

  it("shrinks a small ad group's conversion toward the account's", () => {
    const products = [...PRODUCTS, { advertisedSku: "A", adGroupId: "G2", clicks: 2, purchases7d: 2 }];
    const { insufficient } = analyzeNegatives([term("x", 1, 1, 0, "G2")], products, MARGINS);
    const account = 12 / 102;
    expect(insufficient[0].baselineCvr).toBeCloseTo((2 + PRIOR_CLICKS * account) / (2 + PRIOR_CLICKS), 3);
  });

  it("leaves ad groups without any known cost out of the automation", () => {
    const { summary, proposals } = analyzeNegatives([term("cuarzo gratis", 30, 9)], PRODUCTS, []);
    expect(proposals).toHaveLength(0);
    expect(summary).toMatchObject({ noCost: 1, noCostSpend: 9 });
  });
});

describe("withDecisions", () => {
  it("keeps human decisions for proposals that still exist", () => {
    const { proposals } = analyzeNegatives([term("cuarzo gratis", 30, 9)], PRODUCTS, MARGINS);
    const decided = withDecisions(proposals, { [proposals[0].id]: { decision: "rejected", decidedAt: "2026-10-18T10:00:00Z" } });
    expect(decided[0]).toMatchObject({ status: "rejected", decidedAt: "2026-10-18T10:00:00Z" });
    expect(withDecisions(proposals, {})[0].status).toBe("proposed");
  });
});
