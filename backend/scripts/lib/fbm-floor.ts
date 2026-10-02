/**
 * Regla FBM ≥ FBA × 1,05: en cada país, el precio de una oferta FBM no puede quedar por debajo del
 * precio de la oferta FBA (nueva, no amzn.gr) del mismo ASIN más un 5 %. Si hay varias FBA se toma
 * la más cara. Los precios fijos de fixed_prices.csv mandan sobre la regla.
 */
import { parseCsv } from "./fba-replication";

export const FLOOR_COUNTRIES = ["ES", "DE", "FR", "IT"] as const;
export type FloorCountry = (typeof FLOOR_COUNTRIES)[number];
export const FLOOR_FACTOR = 1.05;

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface AsinPair { asin: string; fbm: string[]; fba: string[] }

/** ASIN con al menos una oferta FBM y una FBA (sin las amzn.gr de Amazon) en catalogo_completo.csv. */
export function pairsFromCatalog(csvText: string): AsinPair[] {
  const [cols, ...rows] = parseCsv(csvText);
  if (!cols) return [];
  const idx = (name: string) => cols.findIndex((h) => h === name || h.endsWith(name));
  const sku = idx("seller-sku"), asin = idx("asin1"), channel = idx("fulfillment-channel");
  if ([sku, asin, channel].includes(-1)) throw new Error("catalogo_completo.csv sin las columnas esperadas");
  const by = new Map<string, AsinPair>();
  for (const r of rows) {
    const s = r[sku], a = r[asin];
    if (!s || !a || s.startsWith("amzn.gr.")) continue;
    const p = by.get(a) ?? { asin: a, fbm: [], fba: [] };
    (r[channel] === "DEFAULT" ? p.fbm : p.fba).push(s);
    by.set(a, p);
  }
  return [...by.values()].filter((p) => p.fbm.length && p.fba.length);
}

/** Claves `${sku}|${país}` con precio fijo en fixed_prices.csv (sku;pais;precio). */
export function fixedPriceKeys(csvText: string): Set<string> {
  const out = new Set<string>();
  for (const [s, c] of parseCsv(csvText).slice(1)) if (s && c) out.add(`${s.trim()}|${c.trim().toUpperCase()}`);
  return out;
}

/** Precio mínimo del FBM a partir de los precios de las FBA del ASIN en ese país. */
export function floorPrice(fbaPrices: number[]): number | null {
  const valid = fbaPrices.filter((p) => Number.isFinite(p) && p > 0);
  return valid.length ? round2(Math.max(...valid) * FLOOR_FACTOR) : null;
}

export interface FbmOffer { sku: string; country: FloorCountry; price: number | null; sale: number | null }

export type FloorDecision =
  | { action: "ok"; floor: number }
  | { action: "raise"; floor: number; from: number }
  | { action: "skip"; reason: string; floor: number | null };

/** Qué hacer con una oferta FBM dado el mínimo de su país. */
export function decide(offer: FbmOffer, floor: number | null, fixed: Set<string>): FloorDecision {
  if (floor == null) return { action: "skip", reason: "sin FBA en ese país", floor };
  if (fixed.has(`${offer.sku}|${offer.country}`)) return { action: "skip", reason: "precio fijo (fixed_prices.csv)", floor };
  if (offer.price == null) return { action: "skip", reason: "sin precio", floor };
  // Con una oferta (discounted_price) vigente, subir el precio normal no cambia lo que paga el cliente.
  if (offer.sale != null && offer.sale < floor) return { action: "skip", reason: `oferta vigente a ${offer.sale}`, floor };
  return offer.price < floor ? { action: "raise", floor, from: offer.price } : { action: "ok", floor };
}
