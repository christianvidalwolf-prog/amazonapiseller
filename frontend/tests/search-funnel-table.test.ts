import assert from "node:assert/strict";
import test from "node:test";
import type { SearchFunnelRow } from "../lib/searchFunnel";
import { EMPTY_FILTERS, filterRows, hasActiveFilters, nextSort, sortRows } from "../lib/searchFunnelTable";

const row = (overrides: Partial<SearchFunnelRow>): SearchFunnelRow =>
  ({ queryText: "q", asin: "B000000001", status: "NORMAL", totalQueryVolume: 0, asinImpressions: 0, asinClicks: 0, asinCartAdds: 0, asinPurchases: 0, ctr: 0, ...overrides }) as SearchFunnelRow;

const rows = [
  row({ queryText: "cuarzo rosa", asin: "B0AAA00001", asinClicks: 40, asinImpressions: 900, ctr: 0.044, status: "WINNER" }),
  row({ queryText: "amatista", asin: "B0BBB00002", asinClicks: 5, asinImpressions: 2000, ctr: 0.0025, status: "DROP_IMPRESSIONS_TO_CLICKS" }),
  row({ queryText: "Ágata", asin: "B0AAA00003", asinClicks: 40, asinImpressions: 100, ctr: 0.4, status: "LOW_VOLUME" }),
];
const names = (list: SearchFunnelRow[]) => list.map((r) => r.queryText);

test("sorts numbers and text in both directions and keeps the impact order on ties", () => {
  assert.deepEqual(names(sortRows(rows, { key: "asinClicks", direction: "desc" })), ["cuarzo rosa", "Ágata", "amatista"]);
  assert.deepEqual(names(sortRows(rows, { key: "asinImpressions", direction: "asc" })), ["Ágata", "cuarzo rosa", "amatista"]);
  assert.deepEqual(names(sortRows(rows, { key: "ctr", direction: "desc" })), ["Ágata", "cuarzo rosa", "amatista"]);
  assert.deepEqual(names(sortRows(rows, { key: "queryText", direction: "asc" })), ["Ágata", "amatista", "cuarzo rosa"]);
  assert.deepEqual(names(sortRows(rows, { key: "status", direction: "asc" })), ["amatista", "cuarzo rosa", "Ágata"]);
  assert.equal(sortRows(rows, null), rows);
  assert.deepEqual(names(rows), ["cuarzo rosa", "amatista", "Ágata"], "the input is not mutated");
});

test("header clicks cycle: best-first, reversed, back to impact", () => {
  const first = nextSort(null, "asinClicks");
  assert.deepEqual(first, { key: "asinClicks", direction: "desc" });
  const second = nextSort(first, "asinClicks");
  assert.deepEqual(second, { key: "asinClicks", direction: "asc" });
  assert.equal(nextSort(second, "asinClicks"), null);
  assert.deepEqual(nextSort(second, "queryText"), { key: "queryText", direction: "asc" });
});

test("filters combine: text, ASIN fragment, status and minimums", () => {
  assert.equal(hasActiveFilters(EMPTY_FILTERS), false);
  assert.deepEqual(names(filterRows(rows, EMPTY_FILTERS)), names(rows));
  assert.deepEqual(names(filterRows(rows, { ...EMPTY_FILTERS, query: "CUARZO" })), ["cuarzo rosa"]);
  assert.deepEqual(names(filterRows(rows, { ...EMPTY_FILTERS, asin: "b0aaa" })), ["cuarzo rosa", "Ágata"]);
  assert.deepEqual(names(filterRows(rows, { ...EMPTY_FILTERS, status: "WINNER" })), ["cuarzo rosa"]);

  const minimums = { ...EMPTY_FILTERS.minimums, asinClicks: "40", asinImpressions: "500" };
  assert.deepEqual(names(filterRows(rows, { ...EMPTY_FILTERS, minimums })), ["cuarzo rosa"]);
  assert.equal(hasActiveFilters({ ...EMPTY_FILTERS, minimums }), true);
  // Text that is not a number is ignored instead of hiding every row.
  assert.equal(filterRows(rows, { ...EMPTY_FILTERS, minimums: { ...EMPTY_FILTERS.minimums, asinClicks: "abc" } }).length, 3);
});
