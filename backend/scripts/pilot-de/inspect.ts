import fs from "node:fs";
import { SpApiClient } from "../../src/spapi/client";
import { env } from "../../src/config/env";
import { getListingsItem } from "../../src/spapi/endpoints/listingsItems";
import { getCatalogItem } from "../../src/spapi/endpoints/catalogItems";

const ES = "A1RKKUPIHCS9HS", DE = "A1PA6795UKMFR9";
const client = new SpApiClient({ credentials: env.spApi });
const missing = JSON.parse(fs.readFileSync("scripts/pilot-de/missing-de.json", "utf-8"));
const out: any[] = [];
for (const r of missing.slice(12, 80)) {
  if (out.length >= 3) break;
  const sku = r["seller-sku"];
  if (!(Number(r["quantity"]) > 0)) continue;
  try {
    await getCatalogItem(client, { asin: r["asin1"], marketplaceIds: [DE], includedData: ["summaries"] });
    continue; // ASIN already in DE catalog -> not the translation case
  } catch {}
  const li: any = await getListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [ES], includedData: ["summaries", "attributes", "offers", "fulfillmentAvailability"] });
  let deName = "";
  try {
    const c = await getCatalogItem(client, { asin: r["asin1"], marketplaceIds: [DE], includedData: ["summaries"] });
    deName = c.summaries?.[0]?.itemName ?? "";
  } catch { deName = "(ASIN no existe en DE)"; }
  const s = li.summaries?.[0] ?? {};
  console.log(`\n${sku} | ${r["asin1"]} | ${s.productType} | ${r["price"]}€ | qty ${r["quantity"]} | attrs ${Object.keys(li.attributes ?? {}).length}`);
  console.log(`  ES: ${s.itemName}`);
  console.log(`  DE: ${deName}`);
  out.push({ sku, asin: r["asin1"], price: r["price"], quantity: r["quantity"], productType: s.productType, esName: s.itemName, deName, attributes: li.attributes });
}
fs.writeFileSync("scripts/pilot-de/inspected2.json", JSON.stringify(out, null, 1));
process.exit(0);
