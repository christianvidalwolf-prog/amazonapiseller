/**
 * Regla de límites de precio (ver src/lib/priceBounds.ts):
 * con oferta, mínimo = mitad del precio de oferta; si el precio supera el máximo, máximo = doble del precio;
 * si el mínimo queda por encima del precio para empresas (B2B), mínimo = mitad del precio B2B.
 *
 * Revisa los FBA de ES en ES/DE/FR/IT y, además, cualquier SKU (FBA o FBM) que Amazon tenga suprimido
 * en cualquier marketplace EU por precio fuera del umbral mínimo (issue 18155, p. ej. "el precio para
 * empresas es inferior al precio mínimo"). Si no tienen mínimo propio se les pone uno explícito a la mitad
 * del precio más bajo (normal, oferta o B2B), que anula el umbral de Amazon. Los suprimidos que la regla no puede arreglar salen en el
 * informe como "suprimido sin ajuste".
 *
 * Ofertas FBA de DE/FR/IT sin precio normal (solo B2B u `our_price` vacío, Amazon las deja DISCOVERABLE): se les pone
 * el de fixed_prices.csv o el de ES con la regla de país (DE = ES, FR = IT = ES + 2 €), conservando la oferta B2B.
 *
 * Por defecto solo informa. Env:
 *   PRICE_BOUNDS_APPLY=1  → envía los cambios a Amazon.
 *   CATALOG_CSV           → ruta a catalogo_completo.csv (por defecto ../catalogo_completo.csv).
 *   FIXED_PRICES_CSV      → ruta a fixed_prices.csv (por defecto ../fixed_prices.csv).
 *   SKUS                  → lista separada por comas para revisar solo esos SKU (en ES/DE/FR/IT, sin escaneo).
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY → informe en snapshots (rules:price-bounds:last-run).
 */
import fs from "node:fs";
import path from "node:path";
import { env } from "../src/config/env";
import { missingFbaPrice, parseFixedPrices, priceBoundsFix, readBusinessPrice, readOfferPrices, suppressedBelowMinFix, withBounds, withoutStaleSales } from "../src/lib/priceBounds";
import { EU_MARKETPLACES } from "../src/modules/account-health/account-health.service";
import { SpApiClient } from "../src/spapi/client";
import { getListingsItem, patchListingsItem, searchListingsItems } from "../src/spapi/endpoints/listingsItems";
import { esFbaListingsFromCatalog } from "./lib/fba-replication";

const APPLY = process.env.PRICE_BOUNDS_APPLY === "1";
const CATALOG = process.env.CATALOG_CSV ?? path.resolve(process.cwd(), "..", "catalogo_completo.csv");
const FIXED_CSV = process.env.FIXED_PRICES_CSV ?? path.resolve(process.cwd(), "..", "fixed_prices.csv");
const REPORT_KEY = "rules:price-bounds:last-run";
const CATALOG_COUNTRIES = ["ES", "DE", "FR", "IT"];
/** Issue de Amazon: precio (normal o B2B) por debajo del umbral mínimo → oferta suprimida. */
const BELOW_MIN_ISSUE = "18155";

const supabaseUrl = (() => {
  const raw = (process.env.SUPABASE_URL ?? "").trim();
  return (raw && !/^https?:\/\//.test(raw) ? `https://${raw}` : raw).replace(/\/+$/, "");
})();
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

async function writeReport(data: unknown): Promise<void> {
  if (!supabaseUrl || !supabaseKey) return;
  const res = await fetch(`${supabaseUrl}/rest/v1/snapshots?on_conflict=key`, {
    method: "POST",
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: REPORT_KEY, data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase upsert ${REPORT_KEY} ${res.status}: ${await res.text()}`);
}

const client = new SpApiClient({ credentials: env.spApi });
const isNotFound = (e: unknown) => /NOT_FOUND|not found/i.test(String(e));

/**
 * SKU suprimidos en un marketplace por precio bajo el umbral mínimo. La búsqueda de Amazon devuelve como
 * mucho ~1000 listings con errores, así que es un complemento: los FBA del catálogo se revisan uno a uno.
 */
async function suppressedBelowMin(marketplaceId: string): Promise<string[]> {
  const skus = new Set<string>();
  let pageToken: string | undefined;
  do {
    const page = await searchListingsItems(client, { sellerId: env.sellerId, marketplaceId, includedData: ["issues"], withIssueSeverity: "ERROR", pageToken });
    for (const item of page.items ?? []) {
      if ((item.issues ?? []).some((i) => i.code === BELOW_MIN_ISSUE)) skus.add(item.sku);
    }
    pageToken = page.pagination?.nextToken;
  } while (pageToken);
  return [...skus];
}

const fixedPrices = fs.existsSync(FIXED_CSV) ? parseFixedPrices(fs.readFileSync(FIXED_CSV, "utf-8")) : new Map<string, number>();
const esPrices = new Map<string, number | null>();

/** Precio normal del SKU en ES (cacheado por ejecución). */
async function esPrice(sku: string, now: Date): Promise<number | null> {
  if (esPrices.has(sku)) return esPrices.get(sku) ?? null;
  const mid = EU_MARKETPLACES.ES.id;
  let price: number | null = null;
  try {
    const listing: any = await getListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [mid], includedData: ["attributes"] });
    const offer = (listing?.attributes?.purchasable_offer ?? []).find((o: any) => (o.audience ?? "ALL") === "ALL" && (o.marketplace_id ?? mid) === mid);
    price = readOfferPrices(offer, now).price;
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  esPrices.set(sku, price);
  return price;
}

/** Oferta FBA de DE/FR/IT sin precio normal → precio fijo o el de ES con la regla de país (B2B intacta). */
async function fillMissingPrice(sku: string, code: string, listing: any, offers: any[], now: Date, report: any[]): Promise<void> {
  const mid = EU_MARKETPLACES[code].id;
  const current = offers.find((o: any) => (o.audience ?? "ALL") === "ALL" && (o.marketplace_id ?? mid) === mid) ?? {};
  const b2b = offers.find((o: any) => o.audience === "B2B" && (o.marketplace_id ?? mid) === mid);
  const es = await esPrice(sku, now);
  const price = missingFbaPrice(code, es, fixedPrices.get(`${sku}|${code}`));
  const business = readBusinessPrice(offers, mid);
  const row = { sku, pais: code, precio: null, precio_es: es, b2b: business, nuevo_precio: price };
  if (price == null) {
    report.push({ ...row, result: "sin precio normal (sin ajuste)", detail: "ES sin precio y sin precio fijo" });
    return;
  }
  if (!APPLY) {
    report.push({ ...row, result: "a poner precio (sin aplicar)" });
    return;
  }
  const base = { ...withoutStaleSales(current, now), currency: "EUR", audience: "ALL", marketplace_id: mid, our_price: [{ schedule: [{ value_with_tax: price }] }] };
  const fix = priceBoundsFix({ ...readOfferPrices(base, now), business });
  const value: unknown[] = [withBounds(base, fix), ...(b2b ? [{ ...b2b, marketplace_id: mid }] : [])];
  const r = await patchListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [mid] }, {
    productType: listing.summaries?.[0]?.productType ?? "PRODUCT",
    patches: [{ op: "replace", path: "/attributes/purchasable_offer", value }],
  });
  report.push({ ...row, result: r.status === "ACCEPTED" ? "precio normal puesto" : "rechazado", ...(r.status === "ACCEPTED" ? {} : { detail: JSON.stringify(r.issues ?? r.status) }) });
}

const isFbaSku = (sku: string) => /FBA$/i.test(sku);

async function checkOffer(sku: string, code: string, flagged: boolean, now: Date, report: any[]): Promise<boolean> {
  const mid = EU_MARKETPLACES[code].id;
  let listing: any;
  try {
    listing = await getListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [mid], includedData: ["attributes", "summaries", "issues"] });
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
  flagged = flagged || (listing?.issues ?? []).some((i: any) => i.code === BELOW_MIN_ISSUE);
  const offers = listing?.attributes?.purchasable_offer || [];
  const offer = offers.find((o: any) => (o.audience ?? "ALL") === "ALL" && (o.marketplace_id ?? mid) === mid);
  const business = readBusinessPrice(offers, mid);
  if (isFbaSku(sku) && code !== "ES" && CATALOG_COUNTRIES.includes(code) && readOfferPrices(offer, now).price == null && (offer || business != null)) {
    await fillMissingPrice(sku, code, listing, offers, now, report);
    return true;
  }
  if (!offer) {
    if (flagged) report.push({ sku, pais: code, b2b: business, result: "suprimido sin ajuste", detail: "sin oferta normal (solo B2B)" });
    return false;
  }
  const prices = { ...readOfferPrices(offer, now), business };
  const fix = flagged ? suppressedBelowMinFix(prices) : priceBoundsFix(prices);
  const row = { sku, pais: code, precio: prices.price, oferta: prices.sale, b2b: prices.business, min: prices.min, max: prices.max, nuevo_min: fix.min, nuevo_max: fix.max };
  if (fix.min == null && fix.max == null) {
    if (flagged) report.push({ ...row, result: "suprimido sin ajuste" });
    return true;
  }
  if (!APPLY) {
    report.push({ ...row, result: "a ajustar (sin aplicar)" });
    return true;
  }
  const r = await patchListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [mid] }, {
    productType: listing.summaries?.[0]?.productType ?? "PRODUCT",
    patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: [withBounds({ ...withoutStaleSales(offer, now), marketplace_id: mid }, fix)] }],
  });
  report.push({ ...row, result: r.status === "ACCEPTED" ? "ajustado" : "rechazado", ...(r.status === "ACCEPTED" ? {} : { detail: JSON.stringify(r.issues ?? r.status) }) });
  return true;
}

async function main() {
  const now = new Date();
  const only = (process.env.SKUS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const catalogSkus = only.length ? only : [...new Set(esFbaListingsFromCatalog(fs.readFileSync(CATALOG, "utf-8")).map((l) => l.sku))];
  const report: any[] = [];
  const suprimidos: Record<string, number> = {};
  let checked = 0;

  for (const code of only.length ? CATALOG_COUNTRIES : Object.keys(EU_MARKETPLACES)) {
    let flagged: string[] = [];
    if (!only.length) {
      try {
        flagged = await suppressedBelowMin(EU_MARKETPLACES[code].id);
        suprimidos[code] = flagged.length;
      } catch (e) {
        report.push({ pais: code, result: "error", detail: `escaneo de suprimidos: ${String(e).slice(0, 200)}` });
      }
    }
    const flaggedSet = new Set(flagged);
    const skus = [...new Set([...(CATALOG_COUNTRIES.includes(code) ? catalogSkus : []), ...flagged])];
    for (const sku of skus) {
      try {
        if (await checkOffer(sku, code, flaggedSet.has(sku), now, report)) checked++;
      } catch (e) {
        report.push({ sku, pais: code, result: "error", detail: String(e).slice(0, 200) });
      }
    }
  }

  const summary: Record<string, number> = {};
  for (const r of report) summary[r.result] = (summary[r.result] ?? 0) + 1;
  await writeReport({ at: now.toISOString(), apply: APPLY, skus: catalogSkus.length, ofertas: checked, suprimidos, summary, items: report });
  console.log(`Price bounds ${APPLY ? "APPLY" : "DRY-RUN"} | SKU catálogo ${catalogSkus.length} | ofertas ${checked} | suprimidos ${JSON.stringify(suprimidos)} | ${JSON.stringify(summary)}`);
  for (const r of report) console.log(" ", JSON.stringify(r));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
