import { describe, expect, it } from "vitest";
import { priceBoundsFix, readOfferPrices, withBounds } from "./priceBounds";

const now = new Date("2026-09-28T10:00:00Z");
const p = (v: number, extra: Record<string, string> = {}) => [{ schedule: [{ value_with_tax: v, ...extra }] }];

describe("readOfferPrices", () => {
  it("reads price, bounds and the lowest non-expired sale", () => {
    const offer = {
      our_price: p(40),
      minimum_seller_allowed_price: p(20),
      maximum_seller_allowed_price: p(80),
      discounted_price: [
        { schedule: [{ value_with_tax: 10, start_at: "2026-01-01", end_at: "2026-01-02" }] },
        { schedule: [{ value_with_tax: 30, start_at: "2026-09-27T00:00:00Z", end_at: "2026-10-05T00:00:00Z" }] },
        { schedule: [{ value_with_tax: 28, start_at: "2026-10-10T00:00:00Z" }] },
      ],
    };
    expect(readOfferPrices(offer, now)).toEqual({ price: 40, sale: 28, min: 20, max: 80 });
  });

  it("ignores expired sales", () => {
    const offer = { our_price: p(40), discounted_price: p(10, { start_at: "2026-01-01", end_at: "2026-01-02" }) };
    expect(readOfferPrices(offer, now).sale).toBeNull();
  });
});

describe("priceBoundsFix", () => {
  it("sets the minimum to half the sale price", () => {
    expect(priceBoundsFix({ price: 40, sale: 30, min: 20, max: 80 })).toEqual({ min: 15 });
    expect(priceBoundsFix({ price: 40, sale: 30, min: 10, max: 80 })).toEqual({ min: 15 });
    expect(priceBoundsFix({ price: 40, sale: 30, min: 15, max: 80 })).toEqual({});
  });

  it("raises the maximum to twice the price when the price went above it", () => {
    expect(priceBoundsFix({ price: 49.95, sale: null, min: 20, max: 45 })).toEqual({ max: 99.9 });
    expect(priceBoundsFix({ price: 45, sale: null, min: 20, max: 45 })).toEqual({});
  });

  it("lowers a minimum left above the price, and leaves missing bounds alone", () => {
    expect(priceBoundsFix({ price: 19.99, sale: null, min: 25, max: 50 })).toEqual({ min: 9.99 });
    expect(priceBoundsFix({ price: 20, sale: null, min: null, max: null })).toEqual({});
  });
});

it("withBounds keeps the rest of the offer", () => {
  const offer = { marketplace_id: "X", our_price: p(40), discounted_price: p(30), minimum_seller_allowed_price: p(20) };
  expect(withBounds(offer, { min: 15 })).toEqual({ ...offer, minimum_seller_allowed_price: p(15) });
});
