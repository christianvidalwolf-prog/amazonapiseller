/**
 * Cambio puntual de precio de un SKU por país (runbook docs/runbooks/listings-inactivos.md, "Cambiar el precio de un SKU").
 * Por cada país: precio normal, B2B = 0,95 × precio (como la sincronización Business) y límites con la regla de
 * src/lib/priceBounds.ts; quita ofertas caducadas o sin importe. Para que el precio no lo revierta el feed FBM de
 * las 9:00 ni enforce-fbm-floor, añade también la fila a fixed_prices.csv.
 *
 * Uso (desde backend/):  npx tsx scripts/ops/set-price.ts <SKU> ES=11.95 DE=16.95 …        (valida con Amazon)
 *                        APPLY=1 npx tsx scripts/ops/set-price.ts <SKU> ES=11.95 DE=16.95 …  (envía)
 */
import { env } from "../../src/config/env";
import { priceBoundsFix, readOfferPrices, withBounds, withoutStaleSales } from "../../src/lib/priceBounds";
import { EU_MARKETPLACES } from "../../src/modules/account-health/account-health.service";
import { SpApiClient } from "../../src/spapi/client";
import { getListingsItem } from "../../src/spapi/endpoints/listingsItems";

const APPLY = process.env.APPLY === "1";
const B2B_FACTOR = 0.95;
const client = new SpApiClient({ credentials: env.spApi });
const round2 = (n: number) => Math.round(n * 100) / 100;

function parseArgs(): { sku: string; prices: Array<[string, number]> } {
  const [sku, ...rest] = process.argv.slice(2);
  const prices = rest.map((arg) => {
    const [code, value] = arg.split("=");
    const price = Number(value?.replace(",", "."));
    if (!EU_MARKETPLACES[code?.toUpperCase()] || !(price > 0)) throw new Error(`Argumento no válido: ${arg} (formato ES=11.95)`);
    return [code.toUpperCase(), price] as [string, number];
  });
  if (!sku || !prices.length) throw new Error("Uso: set-price.ts <SKU> ES=11.95 [DE=16.95 …]");
  return { sku, prices };
}

async function setPrice(sku: string, code: string, price: number): Promise<string> {
  const mid = EU_MARKETPLACES[code].id;
  const listing: any = await getListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [mid], includedData: ["attributes", "summaries"] });
  const offers: any[] = listing.attributes?.purchasable_offer ?? [];
  const current = offers.find((o) => (o.audience ?? "ALL") === "ALL" && (o.marketplace_id ?? mid) === mid) ?? {};
  const b2b = offers.find((o) => o.audience === "B2B" && (o.marketplace_id ?? mid) === mid);
  const business = round2(price * B2B_FACTOR);
  const base = { ...withoutStaleSales(current), currency: "EUR", audience: "ALL", marketplace_id: mid, our_price: [{ schedule: [{ value_with_tax: price }] }] };
  const fix = priceBoundsFix({ ...readOfferPrices(base), business });
  const value: unknown[] = [withBounds(base, fix)];
  if (b2b) value.push({ ...b2b, marketplace_id: mid, our_price: [{ schedule: [{ value_with_tax: business }] }] });
  const before = `${readOfferPrices(current).price ?? "—"} (B2B ${readOfferPrices(b2b).price ?? "—"})`;
  const res: any = await client.request({
    method: "PATCH",
    path: `/listings/2021-08-01/items/${env.sellerId}/${encodeURIComponent(sku)}`,
    query: { marketplaceIds: mid, issueLocale: "es_ES", ...(APPLY ? {} : { mode: "VALIDATION_PREVIEW" }) },
    body: { productType: listing.summaries?.[0]?.productType ?? "PRODUCT", patches: [{ op: "replace", path: "/attributes/purchasable_offer", value }] },
    rateLimitKey: "listingsItems.patchListingsItem",
  });
  const errors = (res.issues ?? []).filter((i: any) => i.severity === "ERROR").map((i: any) => `${i.code} ${i.message}`);
  const bounds = [fix.min != null ? `mín ${fix.min}` : "", fix.max != null ? `máx ${fix.max}` : ""].filter(Boolean).join(" ");
  return `${code} ${before} → ${price} (B2B ${b2b ? business : "sin oferta B2B"}) ${bounds} · ${res.status}${errors.length ? ` · ${errors.join(" | ").slice(0, 300)}` : ""}`;
}

async function main() {
  const { sku, prices } = parseArgs();
  console.log(`${sku} ${APPLY ? "APPLY" : "VALIDACIÓN"}`);
  for (const [code, price] of prices) console.log(" ", await setPrice(sku, code, price));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
