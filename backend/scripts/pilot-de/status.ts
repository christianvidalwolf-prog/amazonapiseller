import { SpApiClient } from "../../src/spapi/client";
import { env } from "../../src/config/env";
import { getListingsItem } from "../../src/spapi/endpoints/listingsItems";
const DE = "A1PA6795UKMFR9";
const client = new SpApiClient({ credentials: env.spApi });
for (const sku of ["11382SGI", "11934VC", "1673SGI", "14572VCI"]) {
  try {
    const li: any = await getListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [DE], includedData: ["summaries", "issues", "offers"] });
    const s = li.summaries?.[0] ?? {};
    const price = li.offers?.[0]?.price?.amount ?? "-";
    console.log(`${sku} | ${s.asin} | status=${JSON.stringify(s.status)} | ${price}€ | ${s.itemName}`);
    for (const i of li.issues ?? []) console.log(`   [${i.severity}] ${i.code} ${i.message.slice(0, 160)}`);
  } catch (e) { console.log(`${sku}: ${(e as Error).message}`); }
}
process.exit(0);
