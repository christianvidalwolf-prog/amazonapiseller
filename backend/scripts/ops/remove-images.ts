/**
 * Quita imágenes secundarias de un listing en uno o varios países (p. ej. fotos con marcas de terceros, error 18146
 * "uso indebido de marcas comerciales"; runbook docs/runbooks/listings-inactivos.md). La imagen principal no se
 * puede quitar: hay que sustituirla.
 *
 * Uso (desde backend/):  npx tsx scripts/ops/remove-images.ts <SKU> <PAÍSES> <HUECOS>
 *   p. ej.  npx tsx scripts/ops/remove-images.ts 22092SGFBA IT 5,6,7          (valida con Amazon)
 *           APPLY=1 npx tsx scripts/ops/remove-images.ts 22092SGFBA ES,DE,FR,IT 5,6,7   (envía)
 * HUECOS = números de other_product_image_locator_N.
 */
import { env } from "../../src/config/env";
import { EU_MARKETPLACES } from "../../src/modules/account-health/account-health.service";
import { SpApiClient } from "../../src/spapi/client";
import { getListingsItem, type ListingsItemPatch } from "../../src/spapi/endpoints/listingsItems";

const APPLY = process.env.APPLY === "1";
const client = new SpApiClient({ credentials: env.spApi });

async function removeImages(sku: string, code: string, slots: number[]): Promise<string> {
  const mid = EU_MARKETPLACES[code].id;
  const listing: any = await getListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [mid], includedData: ["summaries", "attributes"] });
  const present = slots.filter((n) => listing.attributes?.[`other_product_image_locator_${n}`]);
  if (!present.length) return `${code} sin esas imágenes, nada que quitar`;
  const body: ListingsItemPatch = {
    productType: listing.summaries?.[0]?.productType ?? "PRODUCT",
    // El delete necesita el valor exacto (media_location + marketplace_id): con solo marketplace_id Amazon lo acepta y no hace nada.
    patches: present.map((n) => ({ op: "delete" as const, path: `/attributes/other_product_image_locator_${n}`, value: listing.attributes[`other_product_image_locator_${n}`] })),
  };
  const res: any = await client.request({
    method: "PATCH",
    path: `/listings/2021-08-01/items/${env.sellerId}/${encodeURIComponent(sku)}`,
    query: { marketplaceIds: mid, issueLocale: "es_ES", ...(APPLY ? {} : { mode: "VALIDATION_PREVIEW" }) },
    body,
    rateLimitKey: "listingsItems.patchListingsItem",
  });
  const errors = (res.issues ?? []).filter((i: any) => i.severity === "ERROR").map((i: any) => `${i.code} ${i.message}`);
  return `${code} quitar ${present.join(",")} · ${res.status}${errors.length ? ` · ${errors.join(" | ").slice(0, 300)}` : ""}`;
}

async function main() {
  const [sku, countries, slots] = process.argv.slice(2);
  if (!sku || !countries || !slots) throw new Error("Uso: remove-images.ts <SKU> <ES,DE,…> <5,6,7>");
  const numbers = slots.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  console.log(`${sku} ${APPLY ? "APPLY" : "VALIDACIÓN"}`);
  for (const code of countries.toUpperCase().split(",")) console.log(" ", await removeImages(sku, code, numbers));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
