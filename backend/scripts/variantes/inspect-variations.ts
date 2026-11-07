/**
 * Inspección de variantes (parent/child) de una lista de SKU en un marketplace.
 * Solo lectura: GET Listings Items con summaries, attributes, relationships e issues.
 *
 * Uso (desde backend/):  npx tsx scripts/variantes/inspect-variations.ts SKU1,SKU2 [ES]
 */
import { env } from "../../src/config/env";
import { EU_MARKETPLACES } from "../../src/modules/account-health/account-health.service";
import { SpApiClient } from "../../src/spapi/client";
import { getListingsItem } from "../../src/spapi/endpoints/listingsItems";

const client = new SpApiClient({ credentials: env.spApi });
const [skusArg = "", code = "ES"] = process.argv.slice(2);
const skus = skusArg.split(",").map((s) => s.trim()).filter(Boolean);
const mid = EU_MARKETPLACES[code.toUpperCase()]?.id ?? EU_MARKETPLACES.ES.id;

const isNotFound = (e: unknown) => /NOT_FOUND|not found|404/i.test(String(e));
const first = (v: any) => (Array.isArray(v) ? v[0] : v);
const val = (v: any) => first(v)?.value ?? null;

async function inspect(sku: string) {
  try {
    const l: any = await getListingsItem(client, {
      sellerId: env.sellerId,
      sku,
      marketplaceIds: [mid],
      includedData: ["summaries", "attributes", "relationships", "issues"],
      issueLocale: "es_ES",
    });
    const a = l.attributes ?? {};
    const summary = first(l.summaries) ?? {};
    const dims = {} as Record<string, number | null>;
    for (const name of [
      "item_diameter",
      "item_width",
      "item_height",
      "item_length",
      "item_depth_width_height",
      "item_dimensions",
      "assembled_product_diameter",
      "assembled_product_width",
      "assembled_product_height",
    ]) {
      const attr = a[name];
      if (!attr) continue;
      const unit = first(attr)?.unit ?? first(attr)?.unit_of_measure ?? null;
      const value = first(attr)?.value ?? first(attr)?.length?.value ?? first(attr)?.width?.value ?? first(attr)?.height?.value ?? null;
      if (value != null) dims[name] = { value: Number(value), unit } as any;
    }
    return {
      sku,
      asin: summary.asin ?? val(a.merchant_suggested_asin) ?? null,
      status: summary.status ?? [],
      productType: summary.productType ?? null,
      title: val(a.item_name) ?? summary.itemName ?? null,
      parentage: val(a.parentage_level),
      theme: first(a.variation_theme)?.name ?? val(a.variation_theme),
      relationship: first(a.child_parent_sku_relationship) ?? null,
      parentSku: first(a.child_parent_sku_relationship)?.parent_sku ?? null,
      children: (l.relationships ?? [])
        .filter((r: any) => r?.child_skus || r?.parent_skus)
        .map((r: any) => ({ type: r.relationship_type, parent: r.parent_skus, children: (r.child_skus ?? []).length })),
      color: val(a.color),
      size: val(a.size),
      dims,
      issues: (l.issues ?? []).filter((i: any) => i.severity === "ERROR").map((i: any) => `${i.code}: ${i.message}`),
    };
  } catch (e) {
    if (isNotFound(e)) return { sku, exists: false };
    return { sku, error: String(e).slice(0, 200) };
  }
}

async function main() {
  for (const sku of skus) console.log(JSON.stringify(await inspect(sku)));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
