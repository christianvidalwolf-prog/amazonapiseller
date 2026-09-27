import fs from "node:fs";
import { SpApiClient } from "../../src/spapi/client";
import { env } from "../../src/config/env";
import { previewListingsItem } from "../../src/spapi/endpoints/listingsItems";

const ES = "A1RKKUPIHCS9HS", DE = "A1PA6795UKMFR9";
const PRICE_DELTA = 5;
const DROP = new Set(["recommended_browse_nodes", "condition_note", "child_parent_sku_relationship", "parentage_level", ...(process.env.DROP ?? "").split(",").filter(Boolean)]);

const client = new SpApiClient({ credentials: env.spApi });
const pilot = JSON.parse(fs.readFileSync("scripts/pilot-de/pilot.json", "utf-8"));
const tr = JSON.parse(fs.readFileSync("scripts/pilot-de/translations-de.json", "utf-8"));
const extras = JSON.parse(fs.readFileSync("scripts/pilot-de/extras-de.json", "utf-8"));
const withMp = (vals: any[]) => vals.map((v) => ({ ...v, marketplace_id: DE }));

const toDe = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(toDe)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "marketplace_id" && x === ES ? DE : k === "language_tag" && x === "es_ES" ? "de_DE" : toDe(x)]))
  : v;

const round2 = (n: number) => Math.round(n * 100) / 100;
const payloads: Record<string, unknown> = {};

for (const item of pilot) {
  const attrs: Record<string, any[]> = {};
  for (const [key, values] of Object.entries(item.attributes as Record<string, any[]>)) {
    if (DROP.has(key)) continue;
    let vals = toDe(values) as any[];
    const t = tr[item.sku]?.[key];
    if (t) vals = t.map((text: string, i: number) => ({ ...(vals[i] ?? vals[0]), value: text }));
    attrs[key] = vals;
  }
  if (tr[item.sku]?.generic_keyword && !attrs.generic_keyword)
    attrs.generic_keyword = [{ value: tr[item.sku].generic_keyword[0], language_tag: "de_DE", marketplace_id: DE }];

  for (const [k, v] of Object.entries({ ...extras._all, ...(extras[item.sku] ?? {}) })) attrs[k] = withMp(v as any[]);

  const esPrice = Number(item.attributes.purchasable_offer?.[0]?.our_price?.[0]?.schedule?.[0]?.value_with_tax ?? item.price);
  const dePrice = round2(esPrice + PRICE_DELTA);
  attrs.purchasable_offer = [{ currency: "EUR", audience: "ALL", marketplace_id: DE, our_price: [{ schedule: [{ value_with_tax: dePrice }] }] }];
  const esList = Number(item.attributes.list_price?.[0]?.value_with_tax ?? 0);
  attrs.list_price = [{ currency: "EUR", marketplace_id: DE, value_with_tax: round2(Math.max(esList ? esList + PRICE_DELTA : 0, dePrice)) }];

  const body = { productType: item.productType, requirements: "LISTING" as const, attributes: attrs };
  payloads[item.sku] = body;

  const res = await previewListingsItem(client, { sellerId: env.sellerId, sku: item.sku, marketplaceIds: [DE] }, body);
  const errs = (res.issues ?? []).filter((i) => i.severity === "ERROR");
  const warns = (res.issues ?? []).filter((i) => i.severity !== "ERROR");
  console.log(`\n${item.sku}  ES ${esPrice}€ -> DE ${dePrice}€  status=${res.status}  errors=${errs.length} warnings=${warns.length}`);
  for (const i of [...errs, ...warns]) console.log(`  [${i.severity}] ${i.code} ${i.attributeNames?.join(",") ?? ""} :: ${i.message}`);
}
fs.writeFileSync("scripts/pilot-de/payloads-de.json", JSON.stringify(payloads, null, 1));
process.exit(0);
