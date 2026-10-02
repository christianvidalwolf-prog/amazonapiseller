/**
 * Regla FBM ≥ FBA × 1,05 en ES/DE/FR/IT (ver scripts/lib/fbm-floor.ts). Sube el precio de las
 * ofertas FBM que estén por debajo y publica los mínimos de todos los FBM en Supabase
 * (rules:fbm-floor:prices), que sync_daily_stock_amz.py aplica al precio del STOCK AMZ antes de
 * enviarlo, para que la sincronización de la mañana no deshaga la regla.
 *
 * Env:
 *   FBM_FLOOR_APPLY=1 → sube los precios en Amazon; si no, solo calcula, informa y publica los mínimos.
 *   CATALOG_CSV       → catalogo_completo.csv (por defecto ../catalogo_completo.csv).
 *   FIXED_PRICES_CSV  → fixed_prices.csv (por defecto ../fixed_prices.csv); esos SKU/país no se tocan.
 * Informe: rules:fbm-floor:last-run.
 */
import fs from "node:fs";
import path from "node:path";
import { env } from "../src/config/env";
import { priceBoundsFix, readOfferPrices, withBounds } from "../src/lib/priceBounds";
import { SpApiClient } from "../src/spapi/client";
import { getListingsItem, patchListingsItem } from "../src/spapi/endpoints/listingsItems";
import { writeSnapshot } from "./lib/listing-archive-store";
import { pool } from "./lib/listing-cleanup-api";
import { CLEANUP_MARKETPLACES } from "./lib/listing-cleanup";
import { decide, FLOOR_COUNTRIES, type FloorCountry, fixedPriceKeys, floorPrice, pairsFromCatalog } from "./lib/fbm-floor";

const APPLY = process.env.FBM_FLOOR_APPLY === "1";
const root = path.resolve(process.cwd(), "..");
const CATALOG = process.env.CATALOG_CSV ?? path.join(root, "catalogo_completo.csv");
const FIXED = process.env.FIXED_PRICES_CSV ?? path.join(root, "fixed_prices.csv");
const client = new SpApiClient({ credentials: env.spApi });
const IDS = FLOOR_COUNTRIES.map((c) => CLEANUP_MARKETPLACES[c]);

const allOffer = (listing: any, mid: string) =>
  (listing?.attributes?.purchasable_offer ?? []).find((o: any) => (o.audience ?? "ALL") === "ALL" && (o.marketplace_id ?? mid) === mid);

async function getListing(sku: string): Promise<any | null> {
  try {
    return await getListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: IDS, includedData: ["attributes", "summaries"] });
  } catch (e) {
    if (/NOT_FOUND|not found|404/i.test(String(e))) return null;
    throw e;
  }
}

async function main() {
  const at = new Date().toISOString();
  const pairs = pairsFromCatalog(fs.readFileSync(CATALOG, "utf-8"));
  const fixed = fs.existsSync(FIXED) ? fixedPriceKeys(fs.readFileSync(FIXED, "utf-8")) : new Set<string>();
  console.log(`FBM floor ${APPLY ? "APPLY" : "DRY-RUN"} | ASIN con FBM y FBA: ${pairs.length} | precios fijos: ${fixed.size}`);

  const floors: Record<string, Partial<Record<FloorCountry, number>>> = {};
  const items: any[] = [];
  const summary: Record<string, number> = {};
  const count = (k: string) => { summary[k] = (summary[k] ?? 0) + 1; };

  await pool(pairs, 4, async (pair) => {
    try {
      const listings = new Map<string, any>();
      for (const sku of [...pair.fba, ...pair.fbm]) listings.set(sku, await getListing(sku));
      for (const country of FLOOR_COUNTRIES) {
        const mid = CLEANUP_MARKETPLACES[country];
        // Precio efectivo de cada FBA: el de oferta si hay una vigente, si no el normal.
        const fbaPrices = pair.fba.map((s) => { const p = readOfferPrices(allOffer(listings.get(s), mid)); return p.sale ?? p.price; }).filter((p): p is number => p != null);
        const floor = floorPrice(fbaPrices);
        for (const sku of pair.fbm) {
          const offer = allOffer(listings.get(sku), mid);
          if (!offer) continue;
          const prices = readOfferPrices(offer);
          const d = decide({ sku, country, price: prices.price, sale: prices.sale }, floor, fixed);
          if (d.floor != null && !(d.action === "skip" && d.reason.startsWith("precio fijo"))) (floors[sku] ??= {})[country] = d.floor;
          if (d.action === "ok") { count("ok"); continue; }
          if (d.action === "skip") { if (d.floor != null) { count(`omitido: ${d.reason.replace(/[\d.]+/g, "N")}`); items.push({ sku, country, ...d }); } continue; }
          if (!APPLY) { count("a subir (sin aplicar)"); items.push({ sku, country, ...d }); continue; }
          const fix = priceBoundsFix({ ...prices, price: d.floor });
          const r = await patchListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [mid] }, {
            productType: "PRODUCT",
            patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: [withBounds({ marketplace_id: mid, currency: "EUR", audience: "ALL", our_price: [{ schedule: [{ value_with_tax: d.floor }] }] }, fix)] }],
          });
          count(r.status === "ACCEPTED" ? "subido" : "rechazado");
          items.push({ sku, country, ...d, result: r.status, submissionId: r.submissionId, ...fix });
        }
      }
    } catch (e) {
      count("error");
      items.push({ asin: pair.asin, error: String(e).slice(0, 200) });
    }
  });

  await writeSnapshot("rules:fbm-floor:prices", { updatedAt: at, factor: 1.05, prices: floors });
  await writeSnapshot("rules:fbm-floor:last-run", { at, apply: APPLY, pairs: pairs.length, summary, items });
  console.log(`Mínimos publicados para ${Object.keys(floors).length} FBM | ${JSON.stringify(summary)}`);
  for (const it of items.filter((i) => i.action === "raise" || i.error)) console.log(" ", JSON.stringify(it));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
