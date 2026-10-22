// PLANTILLA (runbook docs/runbooks/listings-inactivos.md). Arregla listings FBA inactivos por API.
// Las listas de abajo son las del caso 2026-10-22: sustitúyelas por las del caso nuevo.
// Precio: DE = ES, FR e IT = ES + 2 € (o el fijo de fixed_prices.csv). Mínimo explícito a la mitad del más bajo.
//   1. Ofertas que solo tienen B2B o precio vacío → precio normal.
//   2. SKU con stock FBA sin oferta en un país → oferta nueva (LISTING_OFFER_ONLY) sobre el mismo ASIN.
//   3. Ofertas suprimidas por precio bajo el umbral (18155) → mínimo explícito.
// Uso (desde backend/): npx tsx scripts/ops/fix-inactive.ts (solo valida) · APPLY=1 npx tsx scripts/ops/fix-inactive.ts (envía)
import { env } from "../../src/config/env";
import { readBusinessPrice, readOfferPrices, suppressedBelowMinFix, withBounds, withoutStaleSales } from "../../src/lib/priceBounds";
import { EU_MARKETPLACES } from "../../src/modules/account-health/account-health.service";
import { SpApiClient } from "../../src/spapi/client";
import { getListingsItem, patchListingsItem } from "../../src/spapi/endpoints/listingsItems";
import { copyAttributesFor, offerOnlyPayload, targetPriceForSku } from "../lib/fba-replication";

const APPLY = process.env.APPLY === "1";
const client = new SpApiClient({ credentials: env.spApi });

// 1. Sin precio normal (solo B2B o precio vacío).
const SET_PRICE: Record<string, string[]> = {
  "10617VCFBA": ["DE"], "1295VCFBA": ["DE"], "1886VCFBS": ["DE"], "253285DCFBA": ["DE"], "2776983CLMFBA": ["DE"],
  "3673VCFBA": ["DE"], "4890VCFBA": ["DE"], "18026VCFBA": ["DE", "FR", "IT"], "22731SGFBA": ["DE", "IT"],
  "2597600CLMFBA": ["DE"], "27390RGSGFBA": ["DE", "FR", "IT"], "4746VCIFBA": ["DE"],
  "21821148CLMFBA": ["FR", "IT"], "27585SGRGFBA": ["FR", "IT"],
  "37668RO-ROSSGFBA": ["DE", "FR", "IT"], "37668RO-NARSGFBA": ["DE", "FR", "IT"],
  "2776653CLMFBA": ["FR"], "30052MDFBA": ["FR"],
};
// 2. Sin oferta en el país. `source`: país del que se toman ASIN/productType/atributos (por defecto ES);
//    `esPrice`: precio de referencia ES cuando ES no tiene precio (deducido de la regla DE = ES, FR/IT = ES + 2).
// `replaceShell`: el SKU existe en ese país solo como registro vacío (sin ASIN ni condición) y se rehace con PUT.
const CREATE: Record<string, { countries: string[]; source?: string; esPrice?: number; replaceShell?: string[] }> = {
  "2857133CLMFBA": { countries: ["DE", "FR", "IT"] }, "29308SGFBA": { countries: ["DE", "FR", "IT"] },
  "4921VCFBA": { countries: ["DE", "FR", "IT"] }, "22092SGFBA": { countries: ["IT"] },
  "30330SGFBA": { countries: ["ES"], source: "DE", esPrice: 41.65 },
  "2776439CLMFBA": { countries: ["ES", "DE", "IT"], source: "FR", esPrice: 18, replaceShell: ["ES"] },
};
// Precio fijado a mano en ofertas existentes sin precio (ES sin precio de referencia).
const SET_PRICE_EXPLICIT: Array<[string, string, number]> = [];
// Mercancías peligrosas: si ni la fuente lo tiene, se declara "no aplica" (artículos no peligrosos).
const DG_NOT_APPLICABLE = (mid: string) => ({ supplier_declared_dg_hz_regulation: [{ value: "not_applicable", marketplace_id: mid }] });
// Baterías: si ni la fuente lo tiene, "no necesita" (joyería, minerales y decoración sin pilas).
const NO_BATTERIES = (mid: string) => ({ batteries_required: [{ value: false, marketplace_id: mid }] });
// 3. Suprimidos por umbral de precio con precio normal: mínimo explícito.
const SET_MIN: Array<[string, string]> = [
  ["30330SGFBA", "FR"], ["2776439CLMFBA", "FR"],
  ["amzn.gr.22212969CLM-a8sb3HiyzSNGIR5xH-VG", "DE"], ["amzn.gr.2914123CLM-6-h5Sqci_Dzsjs2Y06-LN", "DE"],
  ["amzn.gr.10168SG-0BdBdhqwBHo3qn-Gb6uqY-LN", "FR"], ["amzn.gr.10168SG-41dawRvb0tN1oJeYqEpsg-LN", "FR"],
  ["amzn.gr.348VC-gxNl3-13CaSrFqzsYK5FOz6-VG", "FR"], ["amzn.gr.2914123CLM-sMsoVF1YGiFMBdZAHV-VG", "IT"],
];

const isNotFound = (e: unknown) => /NOT_FOUND|not found/i.test(String(e));
const get = async (sku: string, code: string): Promise<any | null> => {
  try {
    return await getListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [EU_MARKETPLACES[code].id], includedData: ["attributes", "summaries"] });
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
};
const allOffer = (listing: any, mid: string) => (listing?.attributes?.purchasable_offer ?? []).find((o: any) => (o.audience ?? "ALL") === "ALL" && (o.marketplace_id ?? mid) === mid);
const target = (esPrice: number, sku: string, code: string) => (code === "ES" ? esPrice : targetPriceForSku(esPrice, sku, code as "DE" | "FR" | "IT"));

async function patchOffer(sku: string, code: string, listing: any, value: unknown[]) {
  if (!APPLY) return "validado (sin aplicar)";
  const r = await patchListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [EU_MARKETPLACES[code].id] }, {
    productType: listing.summaries?.[0]?.productType ?? "PRODUCT",
    patches: [{ op: "replace", path: "/attributes/purchasable_offer", value }],
  });
  return r.status === "ACCEPTED" ? "ACCEPTED" : `RECHAZADO ${JSON.stringify(r.issues ?? r.status).slice(0, 300)}`;
}

async function putOffer(sku: string, mid: string, body: unknown, preview: boolean): Promise<any> {
  return client.request<any>({
    method: "PUT",
    path: `/listings/2021-08-01/items/${env.sellerId}/${encodeURIComponent(sku)}`,
    query: { marketplaceIds: mid, ...(preview ? { mode: "VALIDATION_PREVIEW" } : {}) },
    body,
    rateLimitKey: "listingsItems.putListingsItem",
  });
}

async function esPriceOf(sku: string): Promise<{ es: any; price: number | null }> {
  const es = await get(sku, "ES");
  return { es, price: readOfferPrices(allOffer(es, EU_MARKETPLACES.ES.id)).price };
}

for (const [sku, countries] of Object.entries(SET_PRICE)) {
  const { price: esPrice } = await esPriceOf(sku);
  if (esPrice == null) { console.log("PRECIO", sku, "sin precio normal en ES: se omite"); continue; }
  for (const code of countries) {
    const mid = EU_MARKETPLACES[code].id;
    const listing = await get(sku, code);
    if (!listing) { console.log("PRECIO", sku, code, "no existe"); continue; }
    const offers = listing.attributes?.purchasable_offer ?? [];
    const current = allOffer(listing, mid);
    if (readOfferPrices(current).price != null) { console.log("PRECIO", sku, code, "ya tiene precio:", readOfferPrices(current).price); continue; }
    const price = target(esPrice, sku, code);
    const base = { ...withoutStaleSales(current ?? {}), currency: "EUR", audience: "ALL", marketplace_id: mid, our_price: [{ schedule: [{ value_with_tax: price }] }] };
    const fix = suppressedBelowMinFix({ ...readOfferPrices(base), business: readBusinessPrice(offers, mid) });
    console.log("PRECIO", sku, code, `ES ${esPrice} → ${price}`, `mín ${fix.min ?? readOfferPrices(base).min}`, await patchOffer(sku, code, listing, [withBounds(base, fix)]));
  }
}

for (const [sku, code, price] of SET_PRICE_EXPLICIT) {
  const mid = EU_MARKETPLACES[code].id;
  const listing = await get(sku, code);
  if (!listing) { console.log("PRECIO", sku, code, "no existe"); continue; }
  const offers = listing.attributes?.purchasable_offer ?? [];
  const current = allOffer(listing, mid);
  if (readOfferPrices(current).price != null) { console.log("PRECIO", sku, code, "ya tiene precio:", readOfferPrices(current).price); continue; }
  const base = { ...withoutStaleSales(current ?? {}), currency: "EUR", audience: "ALL", marketplace_id: mid, our_price: [{ schedule: [{ value_with_tax: price }] }] };
  const fix = suppressedBelowMinFix({ ...readOfferPrices(base), business: readBusinessPrice(offers, mid) });
  console.log("PRECIO", sku, code, `fijo ${price}`, `mín ${fix.min ?? readOfferPrices(base).min}`, await patchOffer(sku, code, listing, [withBounds(base, fix)]));
}

for (const [sku, plan] of Object.entries(CREATE)) {
  const sourceCode = plan.source ?? "ES";
  const src = await get(sku, sourceCode);
  const esPrice = plan.esPrice ?? readOfferPrices(allOffer(src, EU_MARKETPLACES[sourceCode].id)).price;
  const productType = src?.summaries?.[0]?.productType;
  const asin = src?.summaries?.[0]?.asin;
  if (esPrice == null || !productType || !asin) { console.log("CREAR", sku, `sin datos en ${sourceCode}: se omite`); continue; }
  for (const code of plan.countries) {
    const mid = EU_MARKETPLACES[code].id;
    const existing = await get(sku, code);
    const isShell = existing && !existing.summaries?.length && plan.replaceShell?.includes(code);
    if (existing && !isShell) { console.log("CREAR", sku, code, "ya existe"); continue; }
    const price = target(esPrice, sku, code);
    let payload = offerOnlyPayload({ productType, asin, marketplaceId: mid, price });
    let check = await putOffer(sku, mid, payload, true);
    if (check.status !== "VALID") {
      const missing: string[] = (check.issues ?? []).filter((i: any) => i.severity === "ERROR").flatMap((i: any) => i.attributeNames ?? []);
      const extra = {
        ...(missing.includes("supplier_declared_dg_hz_regulation") ? DG_NOT_APPLICABLE(mid) : {}),
        ...(missing.includes("batteries_required") ? NO_BATTERIES(mid) : {}),
        ...copyAttributesFor(src.attributes, missing, mid),
      };
      if (Object.keys(extra).length) {
        payload = offerOnlyPayload({ productType, asin, marketplaceId: mid, price, extra });
        check = await putOffer(sku, mid, payload, true);
      }
    }
    if (check.status !== "VALID") {
      console.log("CREAR", sku, code, price, "NO VÁLIDA", JSON.stringify((check.issues ?? []).filter((i: any) => i.severity === "ERROR")).slice(0, 300));
      continue;
    }
    if (!APPLY) { console.log("CREAR", sku, code, `ref ES ${esPrice} → ${price}`, "validado (sin aplicar)"); continue; }
    const r = await putOffer(sku, mid, payload, false);
    console.log("CREAR", sku, code, price, r.status, r.status === "ACCEPTED" ? "" : JSON.stringify(r.issues).slice(0, 300));
  }
}

for (const [sku, code] of SET_MIN) {
  const mid = EU_MARKETPLACES[code].id;
  const listing = await get(sku, code);
  const offers = listing?.attributes?.purchasable_offer ?? [];
  const current = allOffer(listing, mid);
  if (!current) { console.log("MÍNIMO", sku, code, "sin oferta normal"); continue; }
  const prices = { ...readOfferPrices(current), business: readBusinessPrice(offers, mid) };
  const fix = suppressedBelowMinFix(prices);
  if (fix.min == null && fix.max == null) { console.log("MÍNIMO", sku, code, "sin cambio", JSON.stringify(prices)); continue; }
  console.log("MÍNIMO", sku, code, `precio ${prices.price} b2b ${prices.business} mín ${prices.min} → ${fix.min}`, await patchOffer(sku, code, listing, [withBounds({ ...withoutStaleSales(current), marketplace_id: mid }, fix)]));
}

process.exit(0);
