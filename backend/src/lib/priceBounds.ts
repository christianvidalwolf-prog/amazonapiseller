/**
 * Regla de límites de precio de una oferta (purchasable_offer de Listings Items API):
 *
 * - Con un precio de oferta (discounted_price) vigente o programado, el precio mínimo
 *   (minimum_seller_allowed_price) pasa a ser la mitad del precio de oferta.
 * - Sin oferta, si el mínimo quedó por encima del precio de venta, se baja a la mitad del precio.
 * - Si el precio máximo (maximum_seller_allowed_price) es menor que el precio de venta,
 *   se sube al doble del precio de venta.
 *
 * Un precio fuera de [mínimo, máximo] hace que Amazon desactive la oferta.
 */

export interface OfferPrices {
  price: number | null;
  /** Precio de oferta más bajo entre los no caducados (vigentes o programados). */
  sale: number | null;
  min: number | null;
  max: number | null;
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

export function priceBoundsFix({ price, sale, min, max }: OfferPrices): BoundsFix {
  const fix: BoundsFix = {};
  if (sale != null) {
    if (min !== halfPrice(sale)) fix.min = halfPrice(sale);
  } else if (price != null && min != null && min > price) {
    fix.min = halfPrice(price);
  }
  if (price != null && max != null && max < price) fix.max = doublePrice(price);
  return fix;
}

/** Oferta con los límites corregidos, para un `replace` de /attributes/purchasable_offer. */
export function withBounds(offer: Record<string, unknown>, fix: BoundsFix): Record<string, unknown> {
  const out = { ...offer };
  if (fix.min != null) out.minimum_seller_allowed_price = [{ schedule: [{ value_with_tax: fix.min }] }];
  if (fix.max != null) out.maximum_seller_allowed_price = [{ schedule: [{ value_with_tax: fix.max }] }];
  return out;
}
