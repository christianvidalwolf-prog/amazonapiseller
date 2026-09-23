import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { GET } from "../app/api/sales/details/route";
import type { PeriodOrderDetail } from "../components/sales/PeriodSalesDetail";

function setup(t: TestContext) {
  for (const [key, value] of Object.entries({
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "test-only",
    NODE_ENV: "production",
    NEXT_PUBLIC_API_URL: "",
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

function order(orderId: string, purchaseDate: string, salesChannel = "Amazon.es", orderStatus = "Shipped"): PeriodOrderDetail {
  return {
    orderId, purchaseDate, salesChannel, orderStatus, fulfillmentChannel: "FBA",
    shipCity: "", shipState: "", shipPostalCode: "", shipCountry: "ES",
    isPrime: false, isBusinessOrder: false, currency: "EUR", totalUnits: 3, totalRevenue: 30,
    items: [
      { sku: "SKU", asin: "ASIN", name: "Product", quantity: 2, itemPrice: 20, itemTax: 4, shippingPrice: 3, totalPrice: 23 },
      { sku: "SKU", asin: "ASIN", name: "Product", quantity: 1, itemPrice: 10, itemTax: 2, shippingPrice: 0, totalPrice: 10 },
    ],
  };
}

const fixtures: Record<string, PeriodOrderDetail[]> = {
  "2025-12": [order("dec", "2025-12-31T12:00:00Z")],
  "2026-01": [
    order("jan", "2026-01-01T00:00:00Z"),
    order("german", "2026-01-02T12:00:00Z", "Amazon.de"),
    order("cancelled", "2026-01-02T12:00:00Z", "Amazon.es", "Cancelled"),
    order("outside", "2026-01-06T12:00:00Z"),
  ],
};

function mockSnapshots(t: TestContext) {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    assert.ok(input.startsWith("https://supabase.example/rest/v1/snapshots?"));
    const key = new URL(input).searchParams.get("key")!;
    calls.push(key);
    const month = key.replace("eq.sales:details:", "");
    return Response.json([{ data: { orders: fixtures[month] ?? [] }, updated_at: "2026-01-07T00:00:00Z" }]);
  });
  return calls;
}

function request(query: string) {
  return GET(new NextRequest(`https://dashboard.example/api/sales/details?${query}`));
}

test("weekly orders crossing year/month boundaries load from Supabase with country filtering", async (t) => {
  setup(t);
  const calls = mockSnapshots(t);
  const response = await request("start=2025-12-29&end=2026-01-04&channel=Amazon.es");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(calls.sort(), ["eq.sales:details:2025-12", "eq.sales:details:2026-01"]);
  assert.deepEqual(result.orders.map((item: PeriodOrderDetail) => item.orderId), ["jan", "dec"]);
  assert.deepEqual(result.metrics, { totalRevenue: 60, totalUnits: 6, totalOrders: 2, avgOrderValue: 30 });
  assert.deepEqual(result.products, [{ sku: "SKU", asin: "ASIN", name: "Product", units: 6, revenue: 60, avgPrice: 10, orderCount: 2 }]);
  assert.equal(response.headers.get("x-snapshot-updated-at"), "2026-01-07T00:00:00Z");
});

test("ALL includes every country and excludes cancelled/out-of-range orders", async (t) => {
  setup(t);
  mockSnapshots(t);
  const result = await (await request("start=2025-12-29&end=2026-01-04")).json();
  assert.equal(result.metrics.totalOrders, 3);
  assert.equal(result.metrics.totalRevenue, 90);
});

test("daily selection defaults end to the same day and includes UTC midnight", async (t) => {
  setup(t);
  mockSnapshots(t);
  const result = await (await request("start=2026-01-01")).json();
  assert.deepEqual(result.orders.map((item: PeriodOrderDetail) => item.orderId), ["jan"]);
});

test("a synced day without orders returns a valid empty detail", async (t) => {
  setup(t);
  mockSnapshots(t);
  const response = await request("start=2026-01-03");
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(result.metrics, { totalRevenue: 0, totalUnits: 0, totalOrders: 0, avgOrderValue: 0 });
  assert.deepEqual(result.products, []);
  assert.deepEqual(result.orders, []);
});

test("a missing monthly snapshot is an actionable error, never partial weekly totals", async (t) => {
  setup(t);
  t.mock.method(globalThis, "fetch", async (input: string) => {
    assert.ok(input.startsWith("https://supabase.example/"), "must not call localhost in production");
    const key = new URL(input).searchParams.get("key");
    return Response.json(key?.includes("2025-12") ? [{ data: { orders: fixtures["2025-12"] }, updated_at: "2026-01-07" }] : []);
  });
  const response = await request("start=2025-12-29&end=2026-01-04");
  assert.equal(response.status, 503);
  assert.match((await response.json()).message, /Faltan los pedidos de 2026-01/);
});

test("invalid and excessive date ranges do not contact any data service", async (t) => {
  setup(t);
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected fetch"); });
  for (const query of ["", "start=bad", "start=2026-02-30", "start=2026-01-02&end=2026-01-01", "start=2020-01-01&end=2026-01-01"]) {
    assert.equal((await request(query)).status, 400);
  }
});

test("configured backend remains a fallback when snapshots are not available", async (t) => {
  setup(t);
  process.env.NEXT_PUBLIC_API_URL = "https://backend.example";
  t.mock.method(globalThis, "fetch", async (input: string) => {
    if (input.startsWith("https://supabase.example/")) return Response.json([]);
    const url = new URL(input);
    assert.equal(url.origin, "https://backend.example");
    assert.equal(url.pathname, "/api/sales/details");
    assert.equal(url.searchParams.get("channel"), "Amazon.es");
    return Response.json({ orders: [fixtures["2026-01"][0]] });
  });
  const response = await request("start=2026-01-01&channel=Amazon.es");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).orders.length, 1);
});
