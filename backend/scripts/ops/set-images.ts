/**
 * Sustituye las imágenes de un listing en uno o varios países: principal, secundarias en orden y swatch (= principal).
 * Los huecos secundarios que sobren se quitan. Las imágenes deben estar en una URL pública: el bucket público
 * `listing-images` de Supabase (`/storage/v1/object/public/listing-images/<SKU>/…`) sirve para esto
 * (runbook docs/runbooks/listings-inactivos.md). La principal debe ir sobre fondo blanco puro.
 *
 * Uso (desde backend/):  npx tsx scripts/ops/set-images.ts <SKU> <ES,DE,…> <URL principal> [<URL 1> <URL 2> …]
 *                        APPLY=1 npx tsx scripts/ops/set-images.ts …   (envía)
 */
import { env } from "../../src/config/env";
import { EU_MARKETPLACES } from "../../src/modules/account-health/account-health.service";
import { SpApiClient } from "../../src/spapi/client";
import { getListingsItem, type ListingsItemPatch } from "../../src/spapi/endpoints/listingsItems";

const APPLY = process.env.APPLY === "1";
const MAX_SECONDARY = 8;
const client = new SpApiClient({ credentials: env.spApi });

async function setImages(sku: string, code: string, main: string, others: string[]): Promise<string> {
  const mid = EU_MARKETPLACES[code].id;
  const listing: any = await getListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [mid], includedData: ["summaries", "attributes"] });
  const loc = (url: string) => [{ media_location: url, marketplace_id: mid }];
  const patches: ListingsItemPatch["patches"] = [
    { op: "replace", path: "/attributes/main_product_image_locator", value: loc(main) },
    { op: "replace", path: "/attributes/swatch_product_image_locator", value: loc(main) },
    ...others.map((url, i) => ({ op: "replace" as const, path: `/attributes/other_product_image_locator_${i + 1}`, value: loc(url) })),
  ];
  for (let n = others.length + 1; n <= MAX_SECONDARY; n++) {
    if (listing.attributes?.[`other_product_image_locator_${n}`]) {
      patches.push({ op: "delete", path: `/attributes/other_product_image_locator_${n}`, value: listing.attributes[`other_product_image_locator_${n}`] });
    }
  }
  const res: any = await client.request({
    method: "PATCH",
    path: `/listings/2021-08-01/items/${env.sellerId}/${encodeURIComponent(sku)}`,
    query: { marketplaceIds: mid, issueLocale: "es_ES", ...(APPLY ? {} : { mode: "VALIDATION_PREVIEW" }) },
    body: { productType: listing.summaries?.[0]?.productType ?? "PRODUCT", patches },
    rateLimitKey: "listingsItems.patchListingsItem",
  });
  const errors = (res.issues ?? []).filter((i: any) => i.severity === "ERROR").map((i: any) => `${i.code} ${i.message}`);
  return `${code} principal + ${others.length} secundarias · ${res.status}${errors.length ? ` · ${errors.join(" | ").slice(0, 300)}` : ""}`;
}

async function main() {
  const [sku, countries, main, ...others] = process.argv.slice(2);
  if (!sku || !countries || !main) throw new Error("Uso: set-images.ts <SKU> <ES,DE,…> <URL principal> [<URL 1> …]");
  if (others.length > MAX_SECONDARY) throw new Error(`Como mucho ${MAX_SECONDARY} imágenes secundarias`);
  console.log(`${sku} ${APPLY ? "APPLY" : "VALIDACIÓN"}`);
  for (const code of countries.toUpperCase().split(",")) console.log(" ", await setImages(sku, code, main, others));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
