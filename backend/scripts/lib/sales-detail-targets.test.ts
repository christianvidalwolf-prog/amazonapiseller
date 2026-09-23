import assert from "node:assert/strict";
import test from "node:test";
import { salesDetailTargets } from "./sales-detail-targets";

test("publication covers previous December through the current month", () => {
  const targets = salesDetailTargets(new Date("2026-09-23T12:00:00Z"));
  assert.equal(targets.length, 10);
  assert.deepEqual(targets[0], ["sales:details:2025-12", "/api/sales/details?start=2025-12-01&end=2025-12-31&channel=ALL"]);
  assert.deepEqual(targets.at(-1), ["sales:details:2026-09", "/api/sales/details?start=2026-09-01&end=2026-09-30&channel=ALL"]);
});

test("monthly boundaries include leap day", () => {
  const targets = salesDetailTargets(new Date("2024-03-01T00:00:00Z"));
  assert.deepEqual(targets.find(([key]) => key === "sales:details:2024-02"), ["sales:details:2024-02", "/api/sales/details?start=2024-02-01&end=2024-02-29&channel=ALL"]);
});
