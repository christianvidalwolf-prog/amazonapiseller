import { describe, expect, it } from "vitest";
import { buildSkuContext, ownBuyBox, stockAlpha } from "./adContext";
import { bidAdvice } from "./bidAdvice";

describe("stockAlpha (weeks of cover)", () => {
  it("follows the circuit-breaker steps", () => {
    expect(stockAlpha(0, 5)).toMatchObject({ alpha: 0, flag: "SIN_STOCK" });
    expect(stockAlpha(5, 5)).toMatchObject({ alpha: 0.1, flag: "ROTURA_INMINENTE" });
    expect(stockAlpha(15, 5)).toMatchObject({ alpha: 0.5, flag: "RIESGO_ROTURA" });
    expect(stockAlpha(25, 5)).toMatchObject({ alpha: 0.8, flag: "STOCK_MEDIO" });
    expect(stockAlpha(30, 5)).toMatchObject({ alpha: 1 });
    expect(stockAlpha(null, 5)).toMatchObject({ alpha: 1, flag: "STOCK_NO_VERIFICADO" });
    expect(stockAlpha(10, 0)).toMatchObject({ alpha: 1, woc: null });
  });
});

describe("buildSkuContext", () => {
  it("losing the Buy Box pauses regardless of stock; return rate needs ≥ 10 units", () => {
    const ctx = buildSkuContext({ sku: "A", asin: "B0", fulfillable: 100, units30: 30, units90: 20, returned90: 2, buyBox: false });
    expect(ctx).toMatchObject({ alpha: 0, flags: ["SIN_BUY_BOX"], returnRate: 0.1, unitsPerWeek: 7 });
    expect(buildSkuContext({ sku: "A", asin: null, fulfillable: 100, units30: 3, units90: 9, returned90: 3, buyBox: true }).returnRate).toBeNull();
  });
});

describe("ownBuyBox", () => {
  it("reads our own offer, or says false when someone else holds it", () => {
    expect(ownBuyBox([{ MyOffer: true, IsBuyBoxWinner: true }], "ME")).toBe(true);
    expect(ownBuyBox([{ SellerId: "ME", IsBuyBoxWinner: false }, { SellerId: "X", IsBuyBoxWinner: true }], "ME")).toBe(false);
    expect(ownBuyBox([{ SellerId: "X", IsBuyBoxWinner: true }], "ME")).toBe(false);
    expect(ownBuyBox([], "ME")).toBeNull();
  });
});

describe("bidAdvice", () => {
  const base = { clicks: 50, spend: 10, sameSkuSales: 50, breakEvenAcos: 40, alpha: 1 }; // CPC 0.20, RPC 1.00, target 26 %
  it("max CPC = revenue per click × target ACoS × alpha; raises capped at +20 %", () => {
    expect(bidAdvice(base)).toMatchObject({ targetAcos: 26, cpc: 0.2, maxCpc: 0.26, suggestedCpc: 0.24, bidAction: "subir" });
    expect(bidAdvice({ ...base, sameSkuSales: 20 })).toMatchObject({ maxCpc: 0.1, suggestedCpc: 0.1, bidAction: "bajar" });
  });
  it("pauses without Buy Box/stock and waits for 15 clicks", () => {
    expect(bidAdvice({ ...base, alpha: 0 }).bidAction).toBe("pausar");
    expect(bidAdvice({ ...base, clicks: 10 }).bidAction).toBe("sin_datos");
  });
});
