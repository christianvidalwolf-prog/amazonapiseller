import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET } from "../app/api/brand-analytics/search-funnel/route";

const row = (queryText: string, asin: string, status: string) => ({ queryText, asin, status, lostUnits: 0 });
const payload = (rows: unknown[]) => ({ updatedAt: "2026-10-04T10:00:00Z", period: "WEEK", asins: [], summary: {}, rows });

function useEnv(t: { after(fn: () => void): void }) {
  const saved = { ...process.env };
  process.env.SUPABASE_URL = "https://supabase.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
  process.env.BACKEND_API_URL = "https://backend.example";
  t.after(() => {
    process.env = saved;
  });
}

/** Routes fetch() by host: the Express backend or the Supabase snapshots table. */
function mockFetch(t: { mock: typeof test.mock }, backend: () => Response, snapshotRows: unknown[] | null) {
  t.mock.method(globalThis, "fetch", async (input: string) => {
    if (input.startsWith("https://backend.example/")) return backend();
    assert.ok(input.includes("key=eq.brand-analytics%3Asearch-funnel%3AWEEK"));
    return Response.json(snapshotRows ? [{ data: payload(snapshotRows), updated_at: "2026-10-04T10:04:05Z" }] : []);
  });
}

const request = (query = "") => new NextRequest(`https://dashboard.example/api/brand-analytics/search-funnel?period=WEEK${query}`);

test("an empty backend does not hide the published snapshot", async (t) => {
  useEnv(t);
  mockFetch(t, () => Response.json(payload([])), [row("cuarzo rosa", "ASIN000001", "WINNER")]);
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-snapshot-updated-at"), "2026-10-04T10:04:05Z");
  assert.equal((await response.json()).rows.length, 1);
});

test("a backend with synced rows wins and filters apply to it", async (t) => {
  useEnv(t);
  mockFetch(
    t,
    () => Response.json(payload([row("a", "ASIN000001", "WINNER"), row("b", "ASIN000002", "NORMAL")])),
    [row("old", "ASIN000009", "NORMAL")]
  );
  const body = await (await GET(request("&asin=ASIN000002"))).json();
  assert.deepEqual(body.rows.map((r: { queryText: string }) => r.queryText), ["b"]);
  assert.equal(body.summary.totalQueries, 1);
});

test("the snapshot is served when the backend is unreachable", async (t) => {
  useEnv(t);
  mockFetch(t, () => { throw new Error("ECONNREFUSED"); }, [row("cuarzo rosa", "ASIN000001", "WINNER")]);
  assert.equal((await (await GET(request())).json()).rows.length, 1);
});

test("with nothing published, an empty backend answer is passed through; no source at all is a 503", async (t) => {
  useEnv(t);
  mockFetch(t, () => Response.json(payload([])), null);
  const empty = await GET(request());
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()).rows, []);

  t.mock.restoreAll();
  mockFetch(t, () => { throw new Error("ECONNREFUSED"); }, null);
  assert.equal((await GET(request())).status, 503);
});
