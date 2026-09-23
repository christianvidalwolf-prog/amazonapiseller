import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET } from "../app/api/pricing/offers/route";

test("validates ASIN and reads offer sellers from Supabase", async (t) => {
  for (const [key, value] of Object.entries({ SUPABASE_URL: "https://supabase.example", SUPABASE_SERVICE_ROLE_KEY: "test-only" })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const detail = { asin: "B012345678", offers: [{ sellerId: "SELLER" }] };
  const mocked = t.mock.method(globalThis, "fetch", async (input: string) => {
    assert.equal(new URL(input).searchParams.get("key"), "eq.pricing:offers:B012345678");
    return Response.json([{ data: detail, updated_at: "2026-09-23T12:00:00Z" }]);
  });
  assert.equal((await GET(new NextRequest("https://dashboard.example/api/pricing/offers"))).status, 400);
  assert.equal(mocked.mock.callCount(), 0);
  const response = await GET(new NextRequest("https://dashboard.example/api/pricing/offers?asin=b012345678"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), detail);
});
