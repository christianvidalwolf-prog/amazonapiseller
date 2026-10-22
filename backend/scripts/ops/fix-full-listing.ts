// PLANTILLA (runbook docs/runbooks/listings-inactivos.md): ficha completa (requirements LISTING) con contenido
// traducido + oferta FBA en países donde el ASIN no tiene página (13013 + 90220 item_name).
// Caso original: 1981VCRGFBA / B0H6MFWGC3. Para otro SKU: copia scripts/ops/data/1981VCRGFBA-content.json,
// traduce, y ajusta SKU, ASIN, BROWSE_NODE y los atributos fijos (dimensiones, origen…).
// Uso (desde backend/): npx tsx scripts/ops/fix-full-listing.ts  (valida con VALIDATION_PREVIEW)
//                       ONLY=DE APPLY=1 npx tsx scripts/ops/fix-full-listing.ts  (envía solo esos países)
import fs from "node:fs";
import path from "node:path";
import { env } from "../../src/config/env";
import { EU_MARKETPLACES } from "../../src/modules/account-health/account-health.service";
import { SpApiClient } from "../../src/spapi/client";
import { getListingsItem } from "../../src/spapi/endpoints/listingsItems";

const APPLY = process.env.APPLY === "1";
const SKU = process.env.SKU ?? "1981VCRGFBA";
const ASIN = process.env.ASIN ?? "B0H6MFWGC3";
const content = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "data", `${SKU}-content.json`), "utf-8"));
const client = new SpApiClient({ credentials: env.spApi });
// Categorías del péndulo hermano 347VC (B00KAIZHL4) en cada país; IT no la exige.
const BROWSE_NODE: Record<string, string> = { DE: "3326252031", FR: "3327634031" };

const es: any = await getListingsItem(client, { sellerId: env.sellerId, sku: SKU, marketplaceIds: [EU_MARKETPLACES.ES.id], includedData: ["attributes", "summaries"] });
const productType = es.summaries[0].productType;
const images = Object.fromEntries(
  Object.entries(es.attributes).filter(([k]) => k.endsWith("_image_locator")).map(([k, v]: [string, any]) => [k, v]),
);

function payload(code: string) {
  const mid = EU_MARKETPLACES[code].id;
  const c = content[code];
  const lang = c.lang;
  const v = (value: unknown) => [{ value, marketplace_id: mid }];
  const t = (value: string) => [{ value, language_tag: lang, marketplace_id: mid }];
  const withMid = (arr: any[]) => arr.map((x) => ({ ...x, marketplace_id: mid }));
  return {
    productType,
    requirements: "LISTING",
    attributes: {
      item_name: t(c.title),
      brand: t("ROCKING GIFTS"),
      manufacturer: t("ROCKING GIFTS"),
      bullet_point: c.bullets.map((b: string) => ({ value: b, language_tag: lang, marketplace_id: mid })),
      product_description: t(c.description),
      color: t(c.color),
      unit_count: [{ value: 1, type: { value: c.unit, language_tag: lang }, marketplace_id: mid }],
      item_package_dimensions: [{ length: { unit: "centimeters", value: 10 }, width: { unit: "centimeters", value: 6 }, height: { unit: "centimeters", value: 2 }, marketplace_id: mid }],
      item_package_weight: [{ unit: "kilograms", value: 0.1, marketplace_id: mid }],
      batteries_required: v(false),
      contains_liquid_contents: v(false),
      is_heat_sensitive: v(false),
      supplier_declared_dg_hz_regulation: v("not_applicable"),
      is_expiration_dated_product: v(false),
      country_of_origin: v("IN"),
      list_price: [{ value_with_tax: c.price, currency: "EUR", marketplace_id: mid }],
      ...(BROWSE_NODE[code] ? { recommended_browse_nodes: v(BROWSE_NODE[code]) } : {}),
      ...Object.fromEntries(Object.entries(images).map(([k, arr]) => [k, withMid(arr as any[])])),
      condition_type: v("new_new"),
      merchant_suggested_asin: v(ASIN),
      purchasable_offer: [{
        currency: "EUR", marketplace_id: mid, audience: "ALL",
        our_price: [{ schedule: [{ value_with_tax: c.price }] }],
        minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: Math.round(c.price * 0.95 * 50) / 100 }] }],
      }],
      fulfillment_availability: [{ fulfillment_channel_code: "AMAZON_EU", marketplace_id: mid }],
    },
  };
}

const COUNTRIES = (process.env.ONLY ?? "DE,FR,IT").split(",");
for (const code of COUNTRIES) {
  const mid = EU_MARKETPLACES[code].id;
  const body = payload(code);
  const put = (preview: boolean) => client.request<any>({
    method: "PUT",
    path: `/listings/2021-08-01/items/${env.sellerId}/${encodeURIComponent(SKU)}`,
    query: { marketplaceIds: mid, issueLocale: "es_ES", ...(preview ? { mode: "VALIDATION_PREVIEW" } : {}) },
    body,
    rateLimitKey: "listingsItems.putListingsItem",
  });
  const check = await put(true);
  const errors = (check.issues ?? []).filter((i: any) => i.severity === "ERROR");
  console.log(code, "validación:", check.status, errors.length ? JSON.stringify(errors.map((i: any) => `${i.code} ${i.attributeNames ?? ""}: ${i.message}`)).slice(0, 600) : "");
  if (!APPLY || check.status !== "VALID") continue;
  const r = await put(false);
  console.log(code, "envío:", r.status, r.submissionId, r.issues?.length ? JSON.stringify(r.issues).slice(0, 400) : "");
}

// ES: quitar de la descripción la frase que dejó el generador ("Aquí tienes una descripción optimizada…").
// Con ONLY solo se ejecuta si incluye ES.
if (!process.env.ONLY || process.env.ONLY.includes("ES")) {
  const mid = EU_MARKETPLACES.ES.id;
  const catalog: any = await client.request({ method: "GET", path: `/catalog/2022-04-01/items/${ASIN}`, query: { marketplaceIds: mid, includedData: "attributes" }, rateLimitKey: "catalogItems.getCatalogItem" });
  const current: string = catalog.attributes?.product_description?.[0]?.value ?? "";
  const cleaned = current.replace(/^Aquí tienes una descripción optimizada[^.]*\.\s*Descripción del Producto\s*/i, "");
  if (cleaned === current) {
    console.log("ES descripción: sin la frase, no se toca");
  } else {
    const patch = (preview: boolean) => client.request<any>({
      method: "PATCH",
      path: `/listings/2021-08-01/items/${env.sellerId}/${encodeURIComponent(SKU)}`,
      query: { marketplaceIds: mid, issueLocale: "es_ES", ...(preview ? { mode: "VALIDATION_PREVIEW" } : {}) },
      body: { productType, patches: [{ op: "replace", path: "/attributes/product_description", value: [{ value: cleaned, language_tag: "es_ES", marketplace_id: mid }] }] },
      rateLimitKey: "listingsItems.patchListingsItem",
    });
    const check = await patch(true);
    console.log("ES descripción validación:", check.status, `empieza: "${cleaned.slice(0, 60)}…"`, (check.issues ?? []).filter((i: any) => i.severity === "ERROR").map((i: any) => i.message).join(" | "));
    if (APPLY && check.status === "VALID") console.log("ES descripción envío:", (await patch(false)).status);
  }
}

process.exit(0);
