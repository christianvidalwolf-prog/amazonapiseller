/**
 * Envío REAL que ve el comprador (Product Pricing API, `GET /products/pricing/v0/listings/{sku}/offers`).
 *
 * Por qué existe: `merchant_shipping_group` dice qué plantilla tiene el listing, pero lo que el cliente paga
 * lo calcula Amazon en la oferta y **tarda** en recalcularlo (en el lote de 5.698 SKU del 26/10 tardó hasta
 * un par de días). El verificador de la plantilla puede dar 0 violaciones mientras `Shipping` sigue a 0,00 €,
 * así que esta comprobación es la que demuestra que el arreglo llegó al comprador.
 *
 * Reglas de lectura (verificado en vivo el 2026-11-04):
 *   - Oferta propia = `MyOffer === true` **o** `SellerId` = el nuestro. Un SKU híbrido devuelve DOS ofertas
 *     propias (la FBA con `IsFulfilledByAmazon: true` y `MyOffer: false`, y la FBM con `MyOffer: true`).
 *     La plantilla de envío solo gobierna la FBM: se elige la oferta **no FBA**.
 *   - Si hay más de una oferta FBM propia, manda la que **cobre** (max `Shipping`): un 0,00 € suelto no
 *     invalida que el comprador esté pagando envío.
 *   - `Shipping > 0` = ya cobra (3,99 € o la banda de peso: 3,36 / 4,58 / 8,17). `0` = todavía no.
 *
 * Sin red: entra el payload ya deserializado y sale el veredicto.
 */

/** Importe de un `{CurrencyCode, Amount}` de la Pricing API (Amount puede venir como número o texto). */
export function readMoney(value: unknown): number | null {
  const amount = (value as { Amount?: unknown } | null | undefined)?.Amount;
  if (amount == null || amount === "") return null;
  const n = typeof amount === "number" ? amount : Number(String(amount).replace(",", "."));
  if (!Number.isFinite(n)) return null;
  // + EPSILON: 1.005 * 100 = 100.49999… sin él.
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Oferta de la Pricing API normalizada (solo lo que hace falta para el veredicto). */
export interface PricingOffer {
  sellerId: string | null;
  myOffer: boolean;
  fulfilledByAmazon: boolean;
  listingPrice: number | null;
  shipping: number | null;
  isBuyBoxWinner: boolean;
}

/** `payload.Offers` de getListingOffers → ofertas normalizadas (vacío si no hay). */
export function parsePricingOffers(payload: unknown): PricingOffer[] {
  const offers = (payload as { Offers?: unknown } | null | undefined)?.Offers;
  if (!Array.isArray(offers)) return [];
  return offers.map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const sellerId = typeof o.SellerId === "string" && o.SellerId.trim() !== "" ? o.SellerId.trim() : null;
    return {
      sellerId,
      myOffer: o.MyOffer === true,
      fulfilledByAmazon: o.IsFulfilledByAmazon === true,
      listingPrice: readMoney(o.ListingPrice),
      shipping: readMoney(o.Shipping),
      isBuyBoxWinner: o.IsBuyBoxWinner === true,
    };
  });
}

/** ¿La oferta es nuestra? `MyOffer` manda; `SellerId` cubre las respuestas que no lo traen. */
export function isOwnOffer(offer: PricingOffer, sellerId: string): boolean {
  return offer.myOffer || (!!sellerId && offer.sellerId === sellerId);
}

export type BuyerShippingVerdict = "cobrando" | "aun-cero" | "sin-dato" | "sin-oferta" | "solo-fba";

export interface BuyerShipping {
  verdict: BuyerShippingVerdict;
  /** Precio de la oferta elegida (la FBM propia que manda). */
  price: number | null;
  /** `Shipping` de la oferta elegida. `null` si Amazon no lo devuelve. */
  shipping: number | null;
  /** Ofertas propias encontradas (2 en un SKU híbrido FBA+FBM). */
  ownOffers: number;
  /** Ofertas propias FBM encontradas (las únicas a las que afecta la plantilla). */
  ownFbmOffers: number;
  detail: string;
}

/**
 * Envío que paga el comprador en la oferta propia FBM. Si el SKU solo tiene oferta FBA propia, la plantilla
 * de envío no aplica (`solo-fba`) y no se puede usar como prueba de nada.
 */
export function buyerShipping(payload: unknown, sellerId: string): BuyerShipping {
  const all = parsePricingOffers(payload);
  const own = all.filter((o) => isOwnOffer(o, sellerId));
  const ownFbm = own.filter((o) => !o.fulfilledByAmazon);
  const base = { price: null, shipping: null, ownOffers: own.length, ownFbmOffers: ownFbm.length };
  if (own.length === 0) {
    // `NoBuyableOffers` = el SKU existe pero no tiene oferta comprable (stock 0 o inactivo): no se puede
    // juzgar el envío y no es un fallo de la plantilla.
    const status = (payload as { status?: unknown } | null | undefined)?.status;
    const detail = all.length === 0
      ? (typeof status === "string" && status !== "" && status !== "Success" ? `sin oferta comprable (Amazon: ${status})` : "la oferta no existe en DE")
      : `${all.length} ofertas, ninguna nuestra`;
    return { ...base, verdict: "sin-oferta", detail };
  }
  if (ownFbm.length === 0) {
    return { ...base, verdict: "solo-fba", detail: "solo oferta FBA propia: la plantilla de envío no aplica" };
  }
  // Varias FBM propias (raro): manda la que cobre; si todas son 0,00, sigue siendo 0,00.
  const chosen = ownFbm.reduce((best, o) => ((o.shipping ?? -1) > (best.shipping ?? -1) ? o : best));
  const extra = ownFbm.length > 1 ? ` (+${ownFbm.length - 1} oferta(s) FBM más)` : "";
  const shipping = chosen.shipping;
  if (shipping == null) return { ...base, verdict: "sin-dato", price: chosen.listingPrice, detail: `Amazon no devuelve Shipping${extra}` };
  const price = chosen.listingPrice;
  if (shipping > 0) {
    return { verdict: "cobrando", price, shipping, ownOffers: own.length, ownFbmOffers: ownFbm.length, detail: `cobra ${shipping.toFixed(2).replace(".", ",")} €${extra}` };
  }
  return { verdict: "aun-cero", price, shipping, ownOffers: own.length, ownFbmOffers: ownFbm.length, detail: `Shipping 0,00 €${extra}` };
}

/**
 * SKU del CSV acumulado de PATCH aceptados (`de_shipping_group_aplicados.csv`:
 * `at,sku,plantilla_origen,plantilla_destino`), en orden de aparición y sin duplicados.
 */
export function parseAppliedSkusCsv(text: string): string[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const header = lines[0].split(",").map((h) => h.trim().replace(/^\uFEFF/, "").toLowerCase());
  const col = header.indexOf("sku");
  const seen = new Set<string>();
  const out: string[] = [];
  // Sin cabecera con `sku`, la primera línea ya es un SKU (no se descarta).
  for (const line of lines.slice(col >= 0 ? 1 : 0)) {
    const cells = line.split(",");
    const sku = (col >= 0 ? cells[col] : cells[0])?.trim() ?? "";
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    out.push(sku);
  }
  return out;
}

/** Muestra aleatoria de `n` elementos (`n` ≥ tamaño → todos). No muta la entrada. */
export function pickSample<T>(items: readonly T[], n: number, random: () => number = Math.random): T[] {
  const copy = [...items];
  const size = Math.max(0, Math.floor(n));
  if (size === 0) return [];
  if (size >= copy.length) return copy;
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, size);
}

/** Resumen de la comprobación ("n/m ya cobran, k siguen a 0,00"). */
export function summarizeBuyerShipping(results: Array<{ verdict: BuyerShippingVerdict }>): {
  total: number;
  charging: number;
  stillZero: number;
  unreadable: number;
  other: number;
  /**
   * Código de salida: 1 si algún SKU sigue a 0,00 €. También 1 si hay SKU a comprobar pero **ninguno** se
   * pudo juzgar (todo `sin-oferta` / `solo-fba`): una comprobación no concluyente no puede salir en verde.
   */
  exitCode: 0 | 1;
} {
  const charging = results.filter((r) => r.verdict === "cobrando").length;
  const stillZero = results.filter((r) => r.verdict === "aun-cero").length;
  const unreadable = results.filter((r) => r.verdict === "sin-oferta" || r.verdict === "sin-dato").length;
  const other = results.filter((r) => r.verdict === "solo-fba").length;
  const total = results.length;
  const conclusive = charging + stillZero > 0;
  return { total, charging, stillZero, unreadable, other, exitCode: stillZero > 0 || (total > 0 && !conclusive) ? 1 : 0 };
}
