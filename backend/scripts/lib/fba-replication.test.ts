import assert from "node:assert/strict";
import test from "node:test";
import { copyAttributesFor, esFbaListingsFromCatalog, parseCsv, planRun, targetPrice, targetPriceForSku } from "./fba-replication";

test("target price: DE equals ES, FR/IT add 2 €", () => {
  assert.equal(targetPrice(45.9, "DE"), 45.9);
  assert.equal(targetPrice(45.9, "FR"), 47.9);
  assert.equal(targetPrice(17.5, "IT"), 19.5);
});

test("fixed SKU price overrides the replication rule only in DE/FR/IT", () => {
  assert.equal(targetPriceForSku(12.5, "5878SGFBA", "DE"), 39.99);
  assert.equal(targetPriceForSku(12.5, "5878SGFBA", "FR"), 39.99);
  assert.equal(targetPriceForSku(12.5, "5878SGFBA", "IT"), 39.99);
  assert.equal(targetPriceForSku(12.5, "OTHER", "FR"), 14.5);
});

test("CSV parser keeps quoted delimiters, escaped quotes and newlines inside a field", () => {
  const rows = parseCsv('a;b;c\n1;"x; ""y""\nz";3\n');
  assert.deepEqual(rows, [["a", "b", "c"], ["1", 'x; "y"\nz', "3"]]);
});

test("reads FBA listings from the catalog, skipping FBM and Incomplete rows, with a mangled BOM header", () => {
  const csv = [
    "ï»¿item-name;seller-sku;asin1;fulfillment-channel;status",
    '"Name; with ""quotes""\nand newline";A1FBA;B001;AMAZON_EU;Active',
    "Other;A1;B001;DEFAULT;Active",
    "Third;C1FBA;B003;AMAZON_EU;Incomplete",
    "Fourth;D1FBA;B004;AMAZON_EU;Inactive",
  ].join("\n");
  assert.deepEqual(esFbaListingsFromCatalog(csv), [
    { sku: "A1FBA", asin: "B001", status: "Active" },
    { sku: "D1FBA", asin: "B004", status: "Inactive" },
  ]);
});

test("first run fixes the baseline: existing offers are only filled where missing, never managed", () => {
  const { state, work } = planRun(null, [{ sku: "OLD", asin: "B1", status: "Active" }, { sku: "OFF", asin: "B2", status: "Inactive" }], "t0");
  assert.deepEqual(state.baseline, ["OFF", "OLD"]);
  assert.deepEqual(state.managed, {});
  assert.deepEqual(work, [
    { sku: "OLD", asin: "B1", createOnly: ["DE", "FR", "IT"], manage: [] },
    { sku: "OFF", asin: "B2", createOnly: ["DE", "FR", "IT"], manage: [] },
  ]);
});

test("SKUs added after the baseline are managed in every country", () => {
  const first = planRun(null, [{ sku: "OLD", asin: "B1", status: "Active" }], "t0").state;
  const { state, work } = planRun(first, [{ sku: "OLD", asin: "B1", status: "Active" }, { sku: "NEW", asin: "B9", status: "Inactive" }], "t1");
  assert.deepEqual(Object.keys(state.managed).sort(), ["NEW|DE", "NEW|FR", "NEW|IT"]);
  assert.deepEqual(work.find((w) => w.sku === "NEW"), { sku: "NEW", asin: "B9", createOnly: [], manage: ["DE", "FR", "IT"] });
});

test("a baseline offer the rule created becomes managed only in that country", () => {
  const first = planRun(null, [{ sku: "OLD", asin: "B1", status: "Active" }], "t0").state;
  first.managed["OLD|IT"] = { origin: "created", since: "t0" };
  const { work } = planRun(first, [{ sku: "OLD", asin: "B1", status: "Active" }], "t1");
  assert.deepEqual(work, [{ sku: "OLD", asin: "B1", createOnly: ["DE", "FR"], manage: ["IT"] }]);
});

test("copies only the requested compliance attributes that ES actually has, retagged to the target marketplace", () => {
  const es = { batteries_required: [{ value: false, marketplace_id: "ES" }] };
  assert.deepEqual(copyAttributesFor(es, ["batteries_required", "supplier_declared_dg_hz_regulation"], "IT"), {
    batteries_required: [{ value: false, marketplace_id: "IT" }],
  });
});
