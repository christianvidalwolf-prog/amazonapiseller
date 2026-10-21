import { describe, expect, it } from "vitest";
import { collectAdContext } from "./adContext.sync";

describe("collectAdContext", () => {
  it("only asks FBA stock for FBA SKUs and checks the Buy Box once per ASIN with spend", async () => {
    const asked: string[][] = [];
    const buyBoxAsked: string[] = [];
    const { snapshot } = await collectAdContext(
      [
        { advertisedSku: "1FBA", advertisedAsin: "B01", cost: 2 },
        { advertisedSku: "2", advertisedAsin: "B02", cost: 1 },
        { advertisedSku: "3FBA", advertisedAsin: "B01", cost: 0 },
      ],
      {
        fulfillable: async (skus) => {
          asked.push(skus);
          return new Map([["1FBA", 0], ["2", 0]]);
        },
        buyBox: async (asin) => {
          buyBoxAsked.push(asin);
          return true;
        },
        units30: { "1FBA": { units: 3, returnedUnits: 0 } },
        units90: {},
      }
    );
    expect(asked).toEqual([["1FBA", "3FBA"]]);
    expect(buyBoxAsked).toEqual(["B01", "B02"]);
    const bySku = Object.fromEntries(snapshot.items.map((i) => [i.sku, i]));
    expect(bySku["1FBA"]).toMatchObject({ fulfillable: 0, flags: ["SIN_STOCK"], alpha: 0 });
    expect(bySku["2"]).toMatchObject({ fulfillable: null, flags: ["STOCK_NO_VERIFICADO"], alpha: 1 });
  });
});
