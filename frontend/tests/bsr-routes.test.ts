import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as catalog } from "../app/api/bsr/catalog/route";
import { GET as history } from "../app/api/bsr/history/[asin]/route";

test("BSR routes read Supabase without an Express backend", async (t) => {
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "https://supabase.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
  t.after(() => {
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  });
  const today = new Date().toISOString().slice(0, 10);
  const products = [{ asin: "ASIN1", sku: "SKU1", name: "Product" }];
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    calls.push(input);
    assert.ok(input.startsWith("https://supabase.example/rest/v1/snapshots?"));
    const key = new URL(input).searchParams.get("key");
    const data = key === "eq.bsr:catalog" ? products : {
      asin: "ASIN1",
      history: [
        { date: "2000-01-01", rootRank: 1, detailRank: 1 },
        { date: today, rootRank: 100, detailRank: 10 },
      ],
      stats: { currentRootRank: 100, currentDetailRank: 10 },
    };
    return Response.json([{ data, updated_at: `${today}T00:00:00Z` }]);
  });
  const catalogResponse = await catalog();
  assert.equal(catalogResponse.status, 200);
  assert.deepEqual(await catalogResponse.json(), products);
  const historyResponse = await history(new NextRequest("https://dashboard.example/api/bsr/history/ASIN1?days=14"), { params: { asin: "ASIN1" } });
  assert.equal(historyResponse.status, 200);
  assert.equal(historyResponse.headers.get("x-snapshot-updated-at"), `${today}T00:00:00Z`);
  const result = await historyResponse.json();
  assert.equal(result.history.length, 1);
  assert.equal(result.stats.bestRootRank, 100);
  assert.equal(result.stats.worstDetailRank, 10);
  assert.equal(calls.length, 2);
});

test("invalid history ranges are rejected before contacting any service", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected fetch"); });
  for (const days of ["NaN", "0", "-1", "91", "1.5"]) {
    const response = await history(new NextRequest(`https://dashboard.example/api/bsr/history/ASIN1?days=${days}`), { params: { asin: "ASIN1" } });
    assert.equal(response.status, 400);
  }
});
