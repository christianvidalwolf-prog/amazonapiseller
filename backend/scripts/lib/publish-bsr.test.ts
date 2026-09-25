import assert from "node:assert/strict";
import test from "node:test";
import { publishBsrSnapshots } from "./publish-bsr";

test("publishes histories beyond the first 40 products before exposing the catalog", async () => {
  const catalog = Array.from({ length: 45 }, (_, i) => ({ asin: `ASIN${i}` }));
  const writes = new Map<string, unknown>();
  const reads: string[] = [];
  const count = await publishBsrSnapshots(async (path) => {
    reads.push(path);
    return path === "/api/bsr/catalog" ? catalog : { history: [] };
  }, async (key, data) => { writes.set(key, data); });
  assert.equal(count, 46);
  assert.equal(reads.filter((path) => path === "/api/bsr/catalog").length, 1);
  assert.ok(reads.includes("/api/bsr/history/ASIN44?days=90"));
  assert.ok(writes.has("bsr:history:ASIN44"));
  assert.equal([...writes.keys()].at(-1), "bsr:catalog");
});

test("reports failed history reads, continues other products, and preserves the previous catalog", async () => {
  const writes: string[] = [];
  await assert.rejects(publishBsrSnapshots(async (path) => {
    if (path === "/api/bsr/catalog") return [{ asin: "broken" }, { asin: "available" }];
    if (path.includes("broken")) throw new Error("endpoint returned 503");
    return { history: [] };
  }, async (key) => { writes.push(key); }), /broken: endpoint returned 503/);
  assert.deepEqual(writes, ["bsr:history:available"]);
});

test("omits ASINs missing from the selected marketplace", async () => {
  const writes: string[] = [];
  const count = await publishBsrSnapshots(async (path) => {
    if (path === "/api/bsr/catalog") return [{ asin: "missing" }, { asin: "good" }];
    if (path.includes("missing")) throw new Error("NOT_FOUND: Requested item, B08ZG1T4P5, not found in marketplace(s) A1RKKUPIHCS9HS.");
    return { asin: "good", snapshots: [] };
  }, async (key) => { writes.push(key); });
  assert.equal(count, 2);
  assert.deepEqual(writes, ["bsr:history:good", "bsr:catalog"]);
});

test("does not report success when Supabase refuses a history write", async () => {
  await assert.rejects(publishBsrSnapshots(async () => [{ asin: "ASIN1" }], async () => {
    throw new Error("Supabase upsert failed (401)");
  }), /ASIN1: Supabase upsert failed/);
});

test("rejects malformed catalogs before writing any snapshots", async () => {
  let writes = 0;
  await assert.rejects(publishBsrSnapshots(async () => ({ error: "unavailable" }), async () => {
    writes++;
  }), /Invalid BSR catalog/);
  assert.equal(writes, 0);
});

test("publishes another marketplace under prefixed keys, skipping unranked products", async () => {
  const writes: string[] = [];
  const reads: string[] = [];
  const count = await publishBsrSnapshots(async (path) => {
    reads.push(path);
    if (path.startsWith("/api/bsr/catalog")) {
      return [{ asin: "RANKED", rootCategory: { rank: 12 } }, { asin: "UNRANKED", rootCategory: null, detailCategory: null }];
    }
    return { history: [] };
  }, async (key) => { writes.push(key); }, "DE");
  assert.equal(count, 2);
  assert.ok(reads.includes("/api/bsr/catalog?fetchAll=true&marketplace=DE"));
  assert.ok(reads.includes("/api/bsr/history/RANKED?days=90&marketplace=DE"));
  assert.deepEqual(writes, ["bsr:history:DE:RANKED", "bsr:catalog:DE"]);
});
