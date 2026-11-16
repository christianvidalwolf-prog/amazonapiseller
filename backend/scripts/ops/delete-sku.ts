/** Borra un SKU en todos los marketplaces EU donde exista. Uso: SKU=xxx [APPLY=1] npx tsx scripts/ops/delete-sku.ts */
import { env } from "../../src/config/env";
import { SpApiClient } from "../../src/spapi/client";
import { deleteListingsItem, getListingsItem } from "../../src/spapi/endpoints/listingsItems";
import { CLEANUP_MARKETPLACES } from "../lib/listing-cleanup";

const sku = process.env.SKU;
if (!sku) throw new Error("SKU requerido");
const client = new SpApiClient({ credentials: env.spApi });

for (const [code, mp] of Object.entries(CLEANUP_MARKETPLACES)) {
  try {
    const item: any = await getListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [mp], includedData: ["summaries"] });
    const status = item.summaries?.[0]?.status ?? [];
    if (process.env.APPLY !== "1") { console.log(`${code}: existe ${JSON.stringify(status)} (simulación)`); continue; }
    const r = await deleteListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [mp] });
    console.log(`${code}: ${r.status} ${JSON.stringify(r.issues ?? [])}`);
  } catch (e: any) {
    console.log(`${code}: ${e?.statusCode === 404 ? "no existe" : String(e).slice(0, 200)}`);
  }
}
