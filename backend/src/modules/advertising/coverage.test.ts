import { describe, expect, it } from "vitest";
import { buildCoverageInput, selectCoverage } from "./coverage";
import { parseListings } from "./coverage.sync";

const row = (asin: string, units: number, sessions: number, sales: number, usp: number, bb = 100) => ({
  childAsin: asin,
  salesByAsin: { unitsOrdered: units, orderedProductSales: { amount: sales } },
  trafficByAsin: { sessions, unitSessionPercentage: usp, buyBoxPercentage: bb },
});
const window = { start: "2026-10-24", end: "2026-11-22" };

describe("buildCoverageInput", () => {
  it("keeps only ASINs with organic traction and a listing", () => {
    const input = buildCoverageInput(
      "M",
      window,
      [row("B1", 10, 89, 477, 11.2), row("B2", 1, 50, 20, 2), row("B3", 5, 40, 100, 12, 50), row("B4", 4, 30, 80, 13)],
      [
        { sku: "S1FBA", asin: "B1", fba: true },
        { sku: "S1", asin: "B1", fba: false },
        { sku: "S2", asin: "B2", fba: false },
      ]
    );
    expect(input.asins.map((a) => a.asin)).toEqual(["B1"]);
    expect(input.asins[0].skus).toHaveLength(2);
  });
});

describe("selectCoverage", () => {
  const input = buildCoverageInput(
    "M",
    window,
    [row("B1", 10, 89, 477, 11.2), row("B5", 6, 60, 300, 10), row("B6", 4, 40, 200, 10), row("B7", 8, 60, 100, 13)],
    [
      { sku: "S1FBA", asin: "B1", fba: true },
      { sku: "S1", asin: "B1", fba: false },
      { sku: "S5", asin: "B5", fba: false },
      { sku: "S6", asin: "B6", fba: false },
      { sku: "S7", asin: "B7", fba: false },
    ]
  );
  const stock: Record<string, number> = { S1FBA: 20, S1: 50, S5: 1, S6: 30, S7: 30 };

  it("prefers the FBA SKU, needs 2 weeks of cover and skips advertised products", () => {
    const out = selectCoverage(input, { skus: new Set(["S7"]), asins: new Set() }, (s) => stock[s] ?? null);
    expect(out.map((c) => [c.asin, c.sku])).toEqual([
      ["B1", "S1FBA"],
      ["B6", "S6"],
    ]);
  });

  it("respects the daily limit, best sellers first", () => {
    expect(selectCoverage(input, { skus: new Set(), asins: new Set() }, (s) => stock[s] ?? null, 1).map((c) => c.asin)).toEqual(["B1"]);
  });
});

describe("parseListings", () => {
  it("reads asin1, or product-id when the marketplace omits asin1 (FR)", () => {
    const de = "item-name\tseller-sku\tasin1\tfulfillment-channel\tstatus\nX\tS1FBA\tB1\tAMAZON_EU\tActive\nY\tS2\tB2\tDEFAULT\tInactive\n";
    const fr = "\uFEFFitem-name\tseller-sku\tproduct-id-type\tproduct-id\tfulfillment-channel\tstatus\nX\tS3\t1\tB3\tDEFAULT\tActive\n";
    expect(parseListings(de)).toEqual([{ sku: "S1FBA", asin: "B1", fba: true }]);
    expect(parseListings(fr)).toEqual([{ sku: "S3", asin: "B3", fba: false }]);
  });
});
