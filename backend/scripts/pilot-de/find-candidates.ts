import fs from "node:fs";
import { SpApiClient } from "../../src/spapi/client";
import { env } from "../../src/config/env";
import { getListingsItem } from "../../src/spapi/endpoints/listingsItems";
import { getCatalogItem } from "../../src/spapi/endpoints/catalogItems";
import { SpApiError } from "../../src/spapi/types";

const ES = "A1RKKUPIHCS9HS";
const DE = "A1PA6795UKMFR9";
const client = new SpApiClient({ credentials: env.spApi });

const lines = fs.readFileSync("../inventario_fba_con_stock.csv", "utf-8").replace(/^﻿/, "").split(/\r?\n/).slice(1).filter(Boolean);
const rows = lines.map((l) => l.split(";")).filter((c) => Number(c[5]) > 0 && !c[0].startsWith("amzn.gr.")).map((c) => ({ sku: c[0], asin: c[1], name: c[3], stock: Number(c[5]) }));
console.log(`${rows.length} SKUs con stock disponible en ES`);

const found: unknown[] = [];
for (const r of rows) {
  if (found.length >= 12) break;
  let inDe = true;
  try {
    await getListingsItem(client, { sellerId: env.sellerId, sku: r.sku, marketplaceIds: [DE], includedData: ["summaries"] });
  } catch (e) {
    if (e instanceof SpApiError && e.statusCode === 404) inDe = false;
    else { console.log(`skip ${r.sku}: ${(e as Error).message}`); continue; }
  }
  if (inDe) continue;
  let asinInDe = false;
  try {
    const c = await getCatalogItem(client, { asin: r.asin, marketplaceIds: [DE], includedData: ["summaries"] });
    asinInDe = (c.summaries ?? []).length > 0;
    (r as any).deTitle = c.summaries?.[0]?.itemName ?? "";
  } catch (e) {
    if (!(e instanceof SpApiError && e.statusCode === 404)) console.log(`catalog ${r.asin}: ${(e as Error).message}`);
  }
  console.log(`DE_TITLE: ${(r as any).deTitle ?? '-'}`);
  console.log(`FALTA EN DE  ${r.sku}  ${r.asin}  stockES=${r.stock}  asinEnCatalogoDE=${asinInDe}  ${r.name.slice(0, 60)}`);
  found.push({ ...r, asinInDe });
}
fs.writeFileSync("scripts/pilot-de/candidates.json", JSON.stringify(found, null, 2));
process.exit(0);
