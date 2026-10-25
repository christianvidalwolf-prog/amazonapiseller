import { describe, expect, it } from "vitest";
import { missingFbaPrice, offerWithNewPrice, parseFixedPrices, priceBoundsFix, readBusinessPrice, readOfferPrices, suppressedBelowMinFix, withBounds, withoutStaleSales } from "./priceBounds";

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

  it("lowers a minimum left above the business (B2B) price to half of it", () => {
    expect(priceBoundsFix({ price: 49.99, sale: null, min: 48.49, max: null, business: 47.49 })).toEqual({ min: 23.75 });
    expect(priceBoundsFix({ price: 40, sale: 39, min: 20, max: 80, business: 18 })).toEqual({ min: 9 });
    expect(priceBoundsFix({ price: 40, sale: null, min: 20, max: 80, business: 38 })).toEqual({});
    expect(priceBoundsFix({ price: 40, sale: null, min: null, max: null, business: 38 })).toEqual({});
  });
});

it("readBusinessPrice picks the B2B offer of the marketplace", () => {
  const offers = [
    { audience: "ALL", marketplace_id: "ES", our_price: p(49.99) },
    { audience: "B2B", marketplace_id: "DE", our_price: p(40) },
    { audience: "B2B", marketplace_id: "ES", our_price: p(47.49) },
  ];
  expect(readBusinessPrice(offers, "ES")).toBe(47.49);
  expect(readBusinessPrice(offers, "IT")).toBeNull();
  expect(readBusinessPrice(undefined, "ES")).toBeNull();
});

it("withBounds keeps the rest of the offer", () => {
  const offer = { marketplace_id: "X", our_price: p(40), discounted_price: p(30), minimum_seller_allowed_price: p(20) };
  expect(withBounds(offer, { min: 15 })).toEqual({ ...offer, minimum_seller_allowed_price: p(15) });
});

it("suppressedBelowMinFix sets an explicit minimum when the offer has none", () => {
  expect(suppressedBelowMinFix({ price: 9.99, sale: null, min: null, max: null, business: 9.49 })).toEqual({ min: 4.75 });
  expect(suppressedBelowMinFix({ price: 20, sale: 16, min: null, max: null })).toEqual({ min: 8 });
  expect(suppressedBelowMinFix({ price: 49.99, sale: null, min: 48.49, max: null, business: 47.49 })).toEqual({ min: 23.75 });
  expect(suppressedBelowMinFix({ price: 40, sale: null, min: 20, max: 80, business: 38 })).toEqual({});
});

it("withoutStaleSales drops expired or valueless sales and keeps live ones", () => {
  const stale = { schedule: [{ start_at: "2023-10-19T00:00:00.000+02:00", end_at: "2024-01-31T00:00:00.000+01:00" }] };
  const expired = { schedule: [{ value_with_tax: 9, end_at: "2026-01-02" }] };
  const live = { schedule: [{ value_with_tax: 28, start_at: "2026-10-10T00:00:00Z" }] };
  const offer = { audience: "ALL", our_price: p(40), discounted_price: [stale, expired, live] };
  expect(withoutStaleSales(offer, now)).toEqual({ audience: "ALL", our_price: p(40), discounted_price: [live] });
  expect(withoutStaleSales({ audience: "ALL", discounted_price: [stale] }, now)).toEqual({ audience: "ALL" });
});

it("withoutStaleSales empties an offer end_at already in the past, keeps a future or empty one", () => {
  expect(withoutStaleSales({ audience: "ALL", end_at: { value: "2021-11-24T14:03:26.000Z" } }, now)).toEqual({ audience: "ALL", end_at: { value: null } });
  expect(withoutStaleSales({ audience: "ALL", end_at: { value: "2027-01-01T00:00:00Z" } }, now)).toEqual({ audience: "ALL", end_at: { value: "2027-01-01T00:00:00Z" } });
  expect(withoutStaleSales({ audience: "ALL", end_at: { value: null } }, now)).toEqual({ audience: "ALL", end_at: { value: null } });
});

describe("missingFbaPrice", () => {
  it("applies the country offset to the ES price", () => {
    expect(missingFbaPrice("DE", 10.35)).toBe(10.35);
    expect(missingFbaPrice("FR", 10.35)).toBe(12.35);
    expect(missingFbaPrice("IT", 18.95)).toBe(20.95);
  });

  it("prefers the fixed price", () => {
    expect(missingFbaPrice("IT", 18.95, 19.9)).toBe(19.9);
  });

  it("returns null for ES, unknown countries or no ES price", () => {
    expect(missingFbaPrice("ES", 10)).toBeNull();
    expect(missingFbaPrice("NL", 10)).toBeNull();
    expect(missingFbaPrice("DE", null)).toBeNull();
  });
});

describe("parseFixedPrices", () => {
  it("reads sku;pais;precio rows, skipping the header and bad rows", () => {
    const map = parseFixedPrices("sku;pais;precio\n2546235CLMFBA;de;19.90\nBAD;IT;x\n\n257VC;ES;135,00\n");
    expect([...map]).toEqual([["2546235CLMFBA|DE", 19.9], ["257VC|ES", 135]]);
  });
});

describe("offerWithNewPrice", () => {
  const sale = [{ schedule: [{ value_with_tax: 12, start_at: "2026-10-25T00:00:00Z", end_at: "2026-12-31T22:59:59Z" }] }];

  it("keeps the B2B audience and the running sale when changing the price", () => {
    const offers = [
      { marketplace_id: "DE", audience: "ALL", currency: "EUR", our_price: p(20), discounted_price: sale, minimum_seller_allowed_price: p(6) },
      { marketplace_id: "DE", audience: "B2B", currency: "EUR", our_price: p(19) },
    ];
    const value = offerWithNewPrice(offers, "DE", 22);
    expect(value).toHaveLength(2);
    expect(value[0].our_price).toEqual(p(22));
    expect(value[0].discounted_price).toEqual(sale);
    expect(value[0].minimum_seller_allowed_price).toEqual(p(6));
    expect(value[1]).toEqual(offers[1]);
  });

  it("recomputes the minimum from the sale price", () => {
    const offers = [{ marketplace_id: "FR", audience: "ALL", our_price: p(20), discounted_price: sale, minimum_seller_allowed_price: p(15) }];
    expect(offerWithNewPrice(offers, "FR", 20)[0].minimum_seller_allowed_price).toEqual(p(6));
  });

  it("drops offers of other marketplaces and creates a single ALL entry when there is none", () => {
    const offers = [{ marketplace_id: "IT", audience: "ALL", our_price: p(20) }];
    expect(offerWithNewPrice(offers, "DE", 15)).toEqual([
      { currency: "EUR", marketplace_id: "DE", audience: "ALL", our_price: p(15) },
    ]);
    expect(offerWithNewPrice(undefined, "DE", 15)).toHaveLength(1);
  });
});
