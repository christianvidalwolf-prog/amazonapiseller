import { describe, expect, it } from "vitest";
import { buildAdMargins } from "./adMargins";

describe("buildAdMargins", () => {
  it("builds one margin per advertised SKU and keeps failures as nulls with their error", async () => {
    const rows = [{ advertisedSku: "A" }, { advertisedSku: "A" }, { advertisedSku: "B" }, { advertisedSku: "" }];
    const snapshot = await buildAdMargins(
      rows,
      async (sku) => {
        if (sku === "B") throw new Error("No hay precio activo");
        return { price: 12.1, fees: { total: 3 }, landedCost: 2, cost: { vatRate: 21 } };
      },
      new Date("2026-10-18T00:00:00Z")
    );
    expect(snapshot.items).toEqual([
      { sku: "A", price: 12.1, feesTotal: 3, landedCost: 2, vatRate: 21 },
      { sku: "B", price: null, feesTotal: null, landedCost: null, vatRate: null, error: "No hay precio activo" },
    ]);
  });

  it("uses the marketplace country's VAT over Sellerboard's Spanish rate", async () => {
    const snapshot = await buildAdMargins(
      [{ advertisedSku: "A" }],
      async () => ({ price: 11.9, fees: { total: 3 }, landedCost: 2, cost: { vatRate: 21 } }),
      new Date(),
      19
    );
    expect(snapshot.items[0].vatRate).toBe(19);
  });
});

