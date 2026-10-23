/**
 * Datos GPSR de un SKU (error 100632 "regulación general de seguridad del producto"): referencia del fabricante
 * (email) y certificación de seguridad, con los valores que ya llevan los listings de la cuenta
 * (runbook docs/runbooks/listings-inactivos.md). No sirve para el 100632 de RAP/EPR (registro del productor).
 *
 * Uso (desde backend/):  npx tsx scripts/ops/set-gpsr.ts <SKU> DE FR IT          (valida con Amazon)
 *                        APPLY=1 npx tsx scripts/ops/set-gpsr.ts <SKU> DE FR IT  (envía)
 * Env: GPSR_MANUFACTURER_EMAIL (por defecto el de la cuenta, vidalregals@gmail.com).
 */
import { env } from "../../src/config/env";
import { EU_MARKETPLACES } from "../../src/modules/account-health/account-health.service";
import { SpApiClient } from "../../src/spapi/client";
import { getListingsItem, type ListingsItemPatch } from "../../src/spapi/endpoints/listingsItems";

const APPLY = process.env.APPLY === "1";
const EMAIL = process.env.GPSR_MANUFACTURER_EMAIL?.trim() || "vidalregals@gmail.com";
const client = new SpApiClient({ credentials: env.spApi });

async function setGpsr(sku: string, code: string): Promise<string> {
  const mid = EU_MARKETPLACES[code].id;
  const listing: any = await getListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [mid], includedData: ["summaries"] });
  const body: ListingsItemPatch = {
    productType: listing.summaries?.[0]?.productType ?? "PRODUCT",
    patches: [
      { op: "replace", path: "/attributes/gpsr_manufacturer_reference", value: [{ gpsr_manufacturer_email_address: EMAIL, marketplace_id: mid }] },
      { op: "replace", path: "/attributes/gpsr_safety_attestation", value: [{ value: true, marketplace_id: mid }] },
    ],
  };
  const res: any = await client.request({
    method: "PATCH",
    path: `/listings/2021-08-01/items/${env.sellerId}/${encodeURIComponent(sku)}`,
    query: { marketplaceIds: mid, issueLocale: "es_ES", ...(APPLY ? {} : { mode: "VALIDATION_PREVIEW" }) },
    body,
    rateLimitKey: "listingsItems.patchListingsItem",
  });
  const errors = (res.issues ?? []).filter((i: any) => i.severity === "ERROR").map((i: any) => `${i.code} ${i.message}`);
  return `${code} ${res.status}${errors.length ? ` · ${errors.join(" | ").slice(0, 300)}` : ""}`;
}

async function main() {
  const [sku, ...countries] = process.argv.slice(2);
  if (!sku || !countries.length) throw new Error("Uso: set-gpsr.ts <SKU> DE [FR IT …]");
  console.log(`${sku} GPSR ${EMAIL} ${APPLY ? "APPLY" : "VALIDACIÓN"}`);
  for (const code of countries.map((c) => c.toUpperCase())) console.log(" ", await setGpsr(sku, code));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
