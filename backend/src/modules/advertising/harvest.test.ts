import { describe, expect, it } from "vitest";
import { analyzeHarvest } from "./harvest";
import type { MarginInput } from "./profitability";

// 12,10 € incl. VAT → 5 € profit per unit → break-even ACoS 41,32 %, target 26,86 %.
const MARGINS: MarginInput[] = [{ sku: "A", price: 12.1, feesTotal: 3, landedCost: 2, vatRate: 21 }];
const PRODUCTS = [{ advertisedSku: "A", adGroupId: "G1", clicks: 200, purchases7d: 6 }]; // account CVR ≈ 3 %
const term = (searchTerm: string, matchType: string, clicks: number, purchases7d: number, cost: number, sales7d: number) => ({
  searchTerm,
  matchType,
  campaignId: "C1",
  adGroupId: "G1",
  clicks,
  purchases7d,
  cost,
  sales7d,
});

describe("analyzeHarvest", () => {
  it("graduates converting discovery terms to exact (ASIN searches to product targets) with a sustainable bid", () => {
    const res = analyzeHarvest(
      [
        term("salvamanteles mimbre", "TARGETING_EXPRESSION_PREDEFINED", 20, 3, 3, 36), // CVR 15 %, ACoS 8 %
        term("b0abc12345", "TARGETING_EXPRESSION_PREDEFINED", 25, 3, 4, 36),
        term("cesta", "BROAD", 100, 3, 10, 36), // CVR 3 % < 1.5 × account → not graduated
        term("mimbre", "EXACT", 20, 3, 3, 36), // already exact → nothing to harvest
      ],
      PRODUCTS,
      MARGINS
    );
    expect(res.map((r) => [r.type, r.text])).toEqual([
      ["HARVEST_EXACT", "salvamanteles mimbre"],
      ["HARVEST_PRODUCT_TARGET", "B0ABC12345"],
    ]);
    expect(res[0]).toMatchObject({ rule: "harvest", breakEvenAcos: 41.32, targetAcos: 26.86, suggestedBid: 0.48, id: "G1|HARVEST_EXACT|salvamanteles mimbre" });
  });

  it("flags high-ACoS terms with ≥ 5 orders: negate in discovery origin, lower the bid in exact", () => {
    const res = analyzeHarvest(
      [term("cesta grande", "BROAD", 100, 5, 40, 60), term("cesta pequeña", "EXACT", 100, 5, 40, 60)],
      PRODUCTS,
      MARGINS
    );
    expect(res.map((r) => [r.text, r.type, r.rule])).toEqual([
      ["cesta grande", "NEGATIVE_EXACT_ORIGIN", "high_acos"],
      ["cesta pequeña", "BID_DOWN", "high_acos"],
    ]);
  });
});
