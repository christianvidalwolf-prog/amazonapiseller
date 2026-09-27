import { SpApiClient } from "../../src/spapi/client";
import { env } from "../../src/config/env";
import { getProductTypeDefinition, fetchProductTypeSchema } from "../../src/spapi/endpoints/productTypeDefinitions";
import { getListingsItem } from "../../src/spapi/endpoints/listingsItems";
const DE = "A1PA6795UKMFR9";
const client = new SpApiClient({ credentials: env.spApi });
const want: Record<string, string[]> = {
  HOME: ["is_fragile","number_of_items","model_number","list_price","power_plug_type","accepted_voltage_frequency","merchant_shipping_group"],
  INCENSE: ["color","is_fragile","size","power_plug_type","item_length","accepted_voltage_frequency","unit_count","model_number","number_of_items","recommended_browse_nodes"],
  HANGING_ORNAMENT: ["included_components","is_fragile","list_price","part_number","supplier_declared_dg_hz_regulation","unit_count","number_of_items","country_of_origin","model_number"],
};
function enumsOf(node: any): string[] {
  const out: string[] = [];
  const walk = (n: any) => { if (!n || typeof n !== "object") return; if (Array.isArray(n.enum)) out.push(...n.enum.slice(0, 12).map(String)); for (const v of Object.values(n)) walk(v); };
  walk(node); return [...new Set(out)];
}
for (const [pt, fields] of Object.entries(want)) {
  const def = await getProductTypeDefinition(client, { productType: pt, marketplaceId: DE, sellerId: env.sellerId });
  const schema: any = await fetchProductTypeSchema(def);
  console.log(`\n### ${pt}`);
  for (const f of fields) {
    const p = schema.properties?.[f];
    console.log(`${f}: ${p ? JSON.stringify(enumsOf(p)).slice(0, 300) : "(no prop)"}`);
  }
}
for (const sku of ["13872VCI", "14570VCI"]) {
  const li: any = await getListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [DE], includedData: ["summaries","attributes"] });
  const a = li.attributes ?? {};
  console.log(`\n### DE sibling ${sku} ${li.summaries?.[0]?.productType}`);
  for (const k of ["recommended_browse_nodes","is_fragile","power_plug_type","accepted_voltage_frequency","unit_count","number_of_items","item_length","model_number","merchant_shipping_group","color","size"]) console.log(k, JSON.stringify(a[k] ?? null));
}
process.exit(0);
