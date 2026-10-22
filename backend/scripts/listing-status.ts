/**
 * Diagnóstico de un SKU en ES/DE/FR/IT: estado, ASIN, ofertas (normal/B2B, precio y mínimo) y errores de Amazon.
 * Solo lee. Uso: npm run listing:status -- <SKU> [<SKU>…]   (runbook: docs/runbooks/listings-inactivos.md)
 */
import { env } from "../src/config/env";
import { readBusinessPrice, readOfferPrices } from "../src/lib/priceBounds";
import { EU_MARKETPLACES } from "../src/modules/account-health/account-health.service";
import { SpApiClient } from "../src/spapi/client";
import { getListingsItem } from "../src/spapi/endpoints/listingsItems";

const COUNTRIES = (process.env.COUNTRIES ?? "ES,DE,FR,IT").split(",");
const client = new SpApiClient({ credentials: env.spApi });
const isNotFound = (e: unknown) => /NOT_FOUND|not found/i.test(String(e));

async function show(sku: string) {
  console.log(`== ${sku}`);
  for (const code of COUNTRIES) {
    const mid = EU_MARKETPLACES[code].id;
    let listing: any;
    try {
      listing = await getListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [mid], includedData: ["summaries", "attributes", "issues"], issueLocale: "es_ES" });
    } catch (e) {
      console.log(`${code}  ${isNotFound(e) ? "no existe" : String(e).slice(0, 150)}`);
      continue;
    }
    const s = listing.summaries?.[0];
    const offers = listing.attributes?.purchasable_offer ?? [];
    const all = offers.find((o: any) => (o.audience ?? "ALL") === "ALL" && (o.marketplace_id ?? mid) === mid);
    const p = readOfferPrices(all);
    const offer = all ? `precio ${p.price ?? "—"} · oferta ${p.sale ?? "—"} · mín ${p.min ?? "—"} · máx ${p.max ?? "—"}` : "sin oferta normal";
    console.log(`${code}  ${s?.asin ?? "(sin ASIN: registro vacío)"} ${JSON.stringify(s?.status ?? [])} ${s?.productType ?? ""} | ${offer} · B2B ${readBusinessPrice(offers, mid) ?? "—"}`);
    for (const i of listing.issues ?? []) {
      if (i.severity === "ERROR") console.log(`    ${i.code} ${i.message.slice(0, 140)}`);
    }
  }
}

async function main() {
  const skus = process.argv.slice(2);
  if (!skus.length) throw new Error("Uso: npm run listing:status -- <SKU> [<SKU>…]");
  for (const sku of skus) await show(sku);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
