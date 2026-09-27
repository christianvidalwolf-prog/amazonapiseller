import { SpApiClient } from "../../src/spapi/client";
import { env } from "../../src/config/env";
import { getProductTypeDefinition, fetchProductTypeSchema } from "../../src/spapi/endpoints/productTypeDefinitions";
const DE = "A1PA6795UKMFR9";
const client = new SpApiClient({ credentials: env.spApi });
const pick = (s: any, f: string) => JSON.stringify(s.properties[f]?.items?.properties ?? null, (k, v) => (k === "examples" || k === "description" || k === "editable" || k === "hidden" ? undefined : v));
for (const [pt, fs] of [["HANGING_ORNAMENT", ["included_components", "unit_count", "list_price"]], ["INCENSE", ["item_length", "unit_count"]]] as const) {
  const s: any = await fetchProductTypeSchema(await getProductTypeDefinition(client, { productType: pt, marketplaceId: DE, sellerId: env.sellerId }));
  for (const f of fs) console.log(`\n${pt}.${f}: ${pick(s, f).slice(0, 900)}`);
}
process.exit(0);
