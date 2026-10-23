// Copia de backend/src/lib/priceBounds.ts (frontend y backend son paquetes separados); mantener en sync.
/**
 * Regla de límites de precio de una oferta (purchasable_offer de Listings Items API):
 *
 * - Con un precio de oferta (discounted_price) vigente o programado, el precio mínimo
 *   (minimum_seller_allowed_price) pasa a ser la mitad del precio de oferta.
 * - Sin oferta, si el mínimo quedó por encima del precio de venta, se baja a la mitad del precio.
 * - Si el precio máximo (maximum_seller_allowed_price) es menor que el precio de venta,
 *   se sube al doble del precio de venta.
 * - El mínimo también vale para el precio para empresas (oferta B2B): si queda por encima
 *   de él, se baja a la mitad del precio B2B.
 *
 * Un precio fuera de [mínimo, máximo] hace que Amazon desactive la oferta.
 */

export interface OfferPrices {
  price: number | null;
  /** Precio de oferta más bajo entre los no caducados (vigentes o programados). */
  sale: number | null;
  min: number | null;
  max: number | null;
  /** Precio de la oferta B2B (Amazon Business) del mismo marketplace, si la hay. */
  business?: number | null;
}

export interface BoundsFix {
  min?: number;
  max?: number;
}

type Schedule = { value_with_tax?: number | string; start_at?: string; end_at?: string };
type PriceAttr = Array<{ schedule?: Schedule[] }> | undefined;

const round2 = (n: number) => Math.round(n * 100) / 100;
export const halfPrice = (n: number) => round2(n / 2);
export const doublePrice = (n: number) => round2(n * 2);

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

const firstValue = (attr: PriceAttr): number | null => num(attr?.[0]?.schedule?.[0]?.value_with_tax);

export function readOfferPrices(offer: Record<string, unknown> | undefined, now = new Date()): OfferPrices {
  let sale: number | null = null;
  for (const entry of (offer?.discounted_price as PriceAttr) ?? []) {
    for (const s of entry.schedule ?? []) {
      const value = num(s.value_with_tax);
      const end = s.end_at ? Date.parse(s.end_at) : NaN;
      if (value == null || (!Number.isNaN(end) && end <= now.getTime())) continue;
      sale = sale == null ? value : Math.min(sale, value);
    }
  }
  return {
    price: firstValue(offer?.our_price as PriceAttr),
    sale,
    min: firstValue(offer?.minimum_seller_allowed_price as PriceAttr),
    max: firstValue(offer?.maximum_seller_allowed_price as PriceAttr),
  };
}

/** Precio de la oferta B2B de un marketplace dentro de purchasable_offer. */
export function readBusinessPrice(offers: unknown, marketplaceId: string): number | null {
  const list = Array.isArray(offers) ? (offers as Array<Record<string, unknown>>) : [];
  const b2b = list.find((o) => o.audience === "B2B" && (o.marketplace_id ?? marketplaceId) === marketplaceId);
  return firstValue(b2b?.our_price as PriceAttr);
}

export function priceBoundsFix({ price, sale, min, max, business }: OfferPrices): BoundsFix {
  const fix: BoundsFix = {};
  if (sale != null) {
    if (min !== halfPrice(sale)) fix.min = halfPrice(sale);
  } else if (price != null && min != null && min > price) {
    fix.min = halfPrice(price);
  }
  const effectiveMin = fix.min ?? min;
  if (business != null && effectiveMin != null && effectiveMin > business) fix.min = halfPrice(business);
  if (price != null && max != null && max < price) fix.max = doublePrice(price);
  return fix;
}

/**
 * Oferta suprimida por Amazon por precio bajo el umbral mínimo (issue 18155) sin mínimo propio:
 * un mínimo explícito a la mitad del precio más bajo (normal, oferta o B2B) anula el umbral.
 */
export function suppressedBelowMinFix(prices: OfferPrices): BoundsFix {
  const fix = priceBoundsFix(prices);
  if (fix.min != null || prices.min != null) return fix;
  const lowest = [prices.price, prices.sale, prices.business].filter((n): n is number => n != null);
  return lowest.length ? { ...fix, min: halfPrice(Math.min(...lowest)) } : fix;
}

/**
 * Oferta sin las entradas de discounted_price caducadas o sin importe (Amazon rechaza con 99022 un replace de
 * purchasable_offer que arrastra una oferta antigua sin value_with_tax) y sin end_at de la oferta si ya pasó
 * (una oferta con fin en el pasado no se vende: 2776653CLMFBA FR tenía end_at 2021).
 */
export function withoutStaleSales(offer: Record<string, unknown>, now = new Date()): Record<string, unknown> {
  const entries = (offer.discounted_price as PriceAttr) ?? [];
  const live = entries
    .map((entry) => ({ ...entry, schedule: (entry.schedule ?? []).filter((s) => num(s.value_with_tax) != null && !(s.end_at && Date.parse(s.end_at) <= now.getTime())) }))
    .filter((entry) => entry.schedule.length);
  const { discounted_price: _dropped, end_at, ...rest } = offer;
  const endValue = (end_at as { value?: string | null } | undefined)?.value;
  const keepEnd = end_at !== undefined && !(endValue && Date.parse(endValue) <= now.getTime());
  const base = keepEnd ? { ...rest, end_at } : rest;
  return live.length ? { ...base, discounted_price: live } : base;
}

/** Oferta con los límites corregidos, para un `replace` de /attributes/purchasable_offer. */
export function withBounds(offer: Record<string, unknown>, fix: BoundsFix): Record<string, unknown> {
  const out = { ...offer };
  if (fix.min != null) out.minimum_seller_allowed_price = [{ schedule: [{ value_with_tax: fix.min }] }];
  if (fix.max != null) out.maximum_seller_allowed_price = [{ schedule: [{ value_with_tax: fix.max }] }];
  return out;
}
