/**
 * Regla de la plantilla de envío de Alemania (ver docs/runbooks/envio-de-grupo4.md):
 * toda oferta FBM (`fulfillment-channel` DEFAULT) de DE con precio efectivo menor que 35 € tiene que estar
 * en la plantilla de **PAGO** (3,99 €), no en la de envío gratis.
 *
 * Qué plantilla es cuál (verificado en vivo el 2026-11-04, ver el runbook):
 *   - `legacy-template-id` (o el atributo ausente, que el informe llama "GRUPO 0") → **PAGO**, 3,99 €.
 *     Es la plantilla por defecto del vendedor y el destino de esta regla.
 *   - `395e11ea-3c51-4820-aa8f-74e6cf2a4e72` (el informe lo llama "GRUPO 4") → **ENVÍO GRATIS**, 0,00 €.
 *     Es el ORIGEN: los listings baratos que están aquí son la fuga que hay que corregir.
 *
 * La premisa original de este script estaba invertida (daba el UUID por plantilla de pago). La evidencia:
 * `Product Pricing API getListingOffers` sobre nuestras ofertas → GRUPO 4 devuelve Shipping 0.00 y GRUPO 0
 * devuelve 3.99; y los pedidos de los SKU DCI/SGI movidos el 25-26/10 pasaron de 0 € a 3,99 € al pasar del
 * UUID a `legacy-template-id`. Por eso el destino es el valor de texto y NUNCA se borra el atributo.
 *
 * Precio efectivo = precio de la oferta vigente (`discounted_price`) si la hay, si no el precio de venta.
 * El informe maestro solo trae el precio de tarifa, así que se cruza con los overrides del repo, por orden
 * de prioridad: oferta registrada (rules:sales) → precio manual del panel (rules:manual-price:*) →
 * fixed_prices.csv → precio del informe (o el de Amazon, en la fase de aplicación).
 *
 * Sin red y sin fs: todo entra como texto/datos y sale como decisión.
 */
import { readOfferPrices } from "../../src/lib/priceBounds";
import type { ListingsItemPatch } from "../../src/spapi/endpoints/listingsItems";

export const DE_MARKETPLACE_ID = "A1PA6795UKMFR9";

/** DESTINO: plantilla de PAGO (3,99 €). Es la plantilla por defecto del vendedor en DE. */
export const PAID_SHIPPING_GROUP = "legacy-template-id";
/** Etiqueta con la que el informe maestro nombra la plantilla de pago (atributo ausente). */
export const PAID_SHIPPING_LABEL = "GRUPO 0";
/** ORIGEN: plantilla de ENVÍO GRATIS (0,00 €); el informe la llama "GRUPO 4". */
export const FREE_SHIPPING_GROUP = "395e11ea-3c51-4820-aa8f-74e6cf2a4e72";
/** Etiqueta con la que el informe maestro nombra la plantilla de envío gratis. */
export const FREE_SHIPPING_LABEL = "GRUPO 4";

export const SHIPPING_GROUP_ATTR = "merchant_shipping_group";
/** Por debajo de este precio efectivo, la oferta FBM no puede ir con envío gratis. */
export const PRICE_LIMIT = 35;
/** Canal de Amazon del informe para FBM (AMAZON_EU es FBA). */
export const FBM_CHANNEL = "DEFAULT";

export const PRICE_BUCKETS = ["<10", "10-20", "20-30", "30-35", "≥35"] as const;
export type PriceBucket = (typeof PRICE_BUCKETS)[number];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Importe de un campo del informe (acepta "1.234,56", "42,5", " 42.5 "); null si no es un precio válido. */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? round2(raw) : null;
  const text = String(raw ?? "").replace(/[^\d.,]/g, "").trim();
  if (!text) return null;
  // Con punto y coma a la vez manda el último separador; solo coma = decimal.
  const normalized = text.includes(",") && text.includes(".")
    ? (text.lastIndexOf(",") > text.lastIndexOf(".") ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, ""))
    : text.replace(",", ".");
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? round2(value) : null;
}

export interface DeReportRow {
  sku: string;
  asin: string;
  /** Precio de tarifa del informe (no incluye la oferta activa). */
  price: number | null;
  quantity: number | null;
  status: string;
  /** DEFAULT = FBM, AMAZON_EU = FBA. */
  channel: string;
  /** Etiqueta de la plantilla de envío ("GRUPO 0", "GRUPO 4") o el UUID si Amazon lo devuelve así. */
  group: string;
}

/** Filas del informe maestro de DE (GET_MERCHANT_LISTINGS_ALL_DATA, TSV con cabecera). */
export function parseDeReportTsv(text: string): DeReportRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 2) return [];
  const header = lines[0].split("\t").map((h) => h.trim().replace(/^\uFEFF/, ""));
  const idx = (name: string) => header.findIndex((h) => h === name || h.endsWith(name));
  const sku = idx("seller-sku");
  const asin = idx("asin1");
  const price = idx("price");
  const quantity = idx("quantity");
  const status = idx("status");
  const channel = idx("fulfillment-channel");
  const group = idx("merchant-shipping-group");
  if ([sku, asin, price, channel].includes(-1)) {
    throw new Error("El informe de DE no tiene las columnas esperadas (seller-sku, asin1, price, fulfillment-channel)");
  }
  const out: DeReportRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split("\t");
    const sellerSku = (cols[sku] ?? "").trim();
    if (!sellerSku) continue;
    const count = quantity >= 0 ? Number((cols[quantity] ?? "").trim()) : NaN;
    out.push({
      sku: sellerSku,
      asin: (cols[asin] ?? "").trim(),
      price: parseAmount(cols[price]),
      quantity: Number.isFinite(count) ? count : null,
      status: (status >= 0 ? cols[status] ?? "" : "").trim(),
      channel: (cols[channel] ?? "").trim(),
      group: (group >= 0 ? cols[group] ?? "" : "").trim(),
    });
  }
  return out;
}

/** SKU retirados para siempre (blocked_skus.txt): una línea por SKU, `#` para comentarios. */
export function blockedSkusFromText(text: string): Set<string> {
  return new Set(
    text.split(/\r?\n/).map((line) => line.trim().toUpperCase()).filter((line) => line && !line.startsWith("#")),
  );
}

/**
 * Familia de un SKU por su sufijo alfabético: 27761203DCI → DCI, 10000VCT → VCT, 1007VCFBA → VC,
 * 2684319CLMFBA → CLM (el sufijo FBA marca la oferta FBA del mismo producto). Sin sufijo → "sin sufijo".
 */
export function skuFamily(sku: string): string {
  const letters = /([A-Z]+)$/.exec(sku.trim().toUpperCase())?.[1] ?? "";
  if (!letters) return "sin sufijo";
  return letters.length > 3 && letters.endsWith("FBA") ? letters.slice(0, -3) : letters;
}

export interface SaleOverride {
  price: number;
  start: string;
  end: string;
}

/** Overrides que mandan sobre el precio de tarifa del informe, con clave `${sku}|DE`. */
export interface PriceOverrides {
  /** fixed_prices.csv (parseFixedPrices de src/lib/priceBounds.ts). */
  fixed: Map<string, number>;
  /** Precios puestos a mano en el panel (rules:manual-price:<sku>:DE). */
  manual: Map<string, number>;
  /** Ofertas registradas (rules:sales). */
  sales: Map<string, SaleOverride>;
}

export const overrideKey = (sku: string) => `${sku}|DE`;

export function emptyOverrides(): PriceOverrides {
  return { fixed: new Map(), manual: new Map(), sales: new Map() };
}

/** rules:sales de Supabase: {sales: {sku: {DE: {price, start, end}}}} → `${sku}|DE` → oferta. */
export function parseSalesSnapshot(data: unknown): Map<string, SaleOverride> {
  const out = new Map<string, SaleOverride>();
  const sales = (data as { sales?: Record<string, Record<string, unknown>> } | null)?.sales;
  if (!sales || typeof sales !== "object") return out;
  for (const [sku, byCountry] of Object.entries(sales)) {
    const de = byCountry?.DE as { price?: unknown; start?: unknown; end?: unknown } | undefined;
    if (!de) continue;
    const price = parseAmount(de.price);
    if (price == null || !de.start || !de.end) continue;
    out.set(overrideKey(sku), { price, start: String(de.start), end: String(de.end) });
  }
  return out;
}

/**
 * Precio de la oferta registrada si no está caducada. Cuenta también la programada (aún no empezada),
 * igual que readOfferPrices: si el precio va a bajar, la oferta ya debe estar en la plantilla de pago.
 */
export function activeSalePrice(sale: SaleOverride | undefined, now = new Date()): number | null {
  if (!sale) return null;
  const end = Date.parse(sale.end);
  if (!Number.isFinite(end) || end <= now.getTime()) return null;
  return sale.price;
}

export type PriceSource = "informe" | "precio fijo" | "precio manual" | "oferta registrada" | "sin precio";

/** Precio efectivo del SKU en DE con los overrides del repo aplicados. */
export function effectivePrice(
  sku: string,
  reportPrice: number | null,
  overrides: PriceOverrides,
  now = new Date(),
): { price: number | null; source: PriceSource } {
  const key = overrideKey(sku);
  const sale = activeSalePrice(overrides.sales.get(key), now);
  if (sale != null) return { price: sale, source: "oferta registrada" };
  if (overrides.manual.has(key)) return { price: overrides.manual.get(key)!, source: "precio manual" };
  if (overrides.fixed.has(key)) return { price: overrides.fixed.get(key)!, source: "precio fijo" };
  return { price: reportPrice, source: reportPrice == null ? "sin precio" : "informe" };
}

/** Plantilla del atributo: la de envío gratis, la de pago (legacy o ausente) u otra. */
export type ShippingGroupKind = "gratis" | "pago" | "otra" | "sin atributo";

export function shippingGroupKind(value: string | null | undefined): ShippingGroupKind {
  const text = (value ?? "").trim();
  if (!text) return "sin atributo";
  if (text === FREE_SHIPPING_GROUP || /^grupo\s*4$/i.test(text)) return "gratis";
  if (text === PAID_SHIPPING_GROUP || /^grupo\s*0$/i.test(text)) return "pago";
  return "otra";
}

/** ¿El valor (del informe o en vivo) es la plantilla de ENVÍO GRATIS? Es el único origen que se mueve. */
export function isFreeShippingGroup(value: string | null | undefined): boolean {
  return shippingGroupKind(value) === "gratis";
}

/**
 * Identificador de la plantilla que representa el valor: el UUID cuando el valor es la etiqueta "GRUPO 4"
 * del informe, `legacy-template-id` cuando es "GRUPO 0"/ausente, y el valor tal cual si es otra cosa.
 */
export function shippingGroupTemplate(value: string | null | undefined): string {
  const kind = shippingGroupKind(value);
  // Atributo ausente = plantilla por defecto de la cuenta, que es la de pago.
  if (kind === "gratis") return FREE_SHIPPING_GROUP;
  if (kind === "pago" || kind === "sin atributo") return PAID_SHIPPING_GROUP;
  return (value ?? "").trim();
}

/**
 * Tope por ejecución de la fase de aplicación. Se lee de `SHIPPING_GROUP_LIMIT`; un valor que no sea un
 * entero ≥ 1 aborta en vez de convertirse en `0` (`slice(0, NaN)` no escribe nada y parece que fue bien).
 */
export function parseLimit(raw: string | undefined, fallback = 5000): number {
  const text = (raw ?? "").trim();
  if (!text) return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`SHIPPING_GROUP_LIMIT inválido (${JSON.stringify(raw)}): tiene que ser un entero ≥ 1`);
  }
  return value;
}

/** A partir de este tope, la aplicación exige `SHIPPING_GROUP_CONFIRM=1` (evita un `npm run fix:` accidental). */
export const CONFIRM_FROM_LIMIT = 500;

export interface StateLike {
  status: string;
  at: string;
}

/**
 * ¿La entrada del estado local sigue valiendo para no repetir el SKU? Solo los `ok` bloquean, y solo
 * durante `ttlDays` días: pasado ese plazo se vuelve a leer el listing en vivo (así un `ACCEPTED` que Amazon
 * nunca aplicó, o un `ok` decidido con datos transitorios, no deja el SKU barato con envío gratis para
 * siempre). `ttlDays = 0` desactiva la caducidad (comportamiento antiguo: `ok` eterno).
 */
export function stateIsFresh(entry: StateLike | undefined, now: Date, ttlDays: number): boolean {
  if (!entry || entry.status !== "ok") return false;
  if (!(ttlDays > 0)) return true;
  const at = Date.parse(entry.at);
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at < ttlDays * 86_400_000;
}

export type RowAction = "ok" | "mover" | "omitir";

export interface RowDecision {
  action: RowAction;
  /** Motivo estable (sin importes) para poder contarlos. */
  motivo: string;
  /** Precio efectivo con el que se ha decidido. */
  price: number | null;
  source: PriceSource;
  /** Plantilla que tiene hoy (UUID, legacy-template-id, el valor tal cual si es otra, o "" si no hay). */
  plantillaOrigen: string;
  /** Plantilla a la que hay que llevarla; "" si no se toca. */
  plantillaDestino: string;
}

/** Qué hacer con una fila del informe: dejarla, moverla de la plantilla gratis a la de pago, u omitirla. */
export function decideRow(
  row: DeReportRow,
  overrides: PriceOverrides,
  opts: { blocked?: Set<string>; now?: Date } = {},
): RowDecision {
  const { price, source } = effectivePrice(row.sku, row.price, overrides, opts.now ?? new Date());
  const plantillaOrigen = shippingGroupTemplate(row.group);
  const base = { price, source, plantillaOrigen, plantillaDestino: "" };
  if (row.channel !== FBM_CHANNEL) return { action: "ok", motivo: `FBA (${row.channel || "AMAZON_EU"})`, ...base };
  const kind = shippingGroupKind(row.group);
  if (kind === "pago") return { action: "ok", motivo: "ya en plantilla de pago (GRUPO 0)", ...base };
  if (kind === "otra") return { action: "ok", motivo: "otra plantilla (no es la de envío gratis)", ...base };
  if (opts.blocked?.has(row.sku.trim().toUpperCase())) {
    return { action: "omitir", motivo: "SKU retirado (blocked_skus.txt)", ...base };
  }
  if (price == null) return { action: "omitir", motivo: "sin precio", ...base };
  if (price >= PRICE_LIMIT) return { action: "ok", motivo: "precio efectivo ≥ 35 €", ...base };
  return { action: "mover", motivo: "precio efectivo < 35 €", ...base, plantillaDestino: PAID_SHIPPING_GROUP };
}

export function priceBucket(price: number | null): PriceBucket | null {
  if (price == null) return null;
  if (price < 10) return "<10";
  if (price < 20) return "10-20";
  if (price < 30) return "20-30";
  if (price < PRICE_LIMIT) return "30-35";
  return "≥35";
}

export interface DecisionEntry {
  sku: string;
  decision: RowDecision;
  family: string;
}

export interface Summary {
  rows: number;
  acciones: Record<RowAction, number>;
  motivos: Record<string, number>;
  /** Bucket de precio efectivo de las filas a mover. */
  buckets: Record<PriceBucket, number>;
  /** Familia de SKU de las filas a mover. */
  familias: Record<string, number>;
}

export function summarize(entries: DecisionEntry[]): Summary {
  const acciones: Record<RowAction, number> = { ok: 0, mover: 0, omitir: 0 };
  const motivos: Record<string, number> = {};
  const buckets = Object.fromEntries(PRICE_BUCKETS.map((b) => [b, 0])) as Record<PriceBucket, number>;
  const familias: Record<string, number> = {};
  for (const { decision, family } of entries) {
    acciones[decision.action]++;
    motivos[decision.motivo] = (motivos[decision.motivo] ?? 0) + 1;
    if (decision.action !== "mover") continue;
    const bucket = priceBucket(decision.price);
    if (bucket) buckets[bucket]++;
    familias[family] = (familias[family] ?? 0) + 1;
  }
  return { rows: entries.length, acciones, motivos, buckets, familias };
}

/**
 * Payload del PATCH: un único JSON pointer sobre `merchant_shipping_group`, con el valor de la plantilla
 * de PAGO. Nunca se borra el atributo (dejarlo ausente lo devuelve a la plantilla por defecto, pero un
 * `delete` sobre listings con plantilla asignada es justo lo que no queremos tocar) y nunca se envían
 * precios, stock ni otros atributos. El productType es el que devuelve el GET del listing (si no, "PRODUCT").
 */
export function shippingGroupPatch(productType?: string | null): ListingsItemPatch {
  return {
    productType: productType?.trim() || "PRODUCT",
    patches: [
      {
        op: "replace",
        path: `/attributes/${SHIPPING_GROUP_ATTR}`,
        value: [{ value: PAID_SHIPPING_GROUP, marketplace_id: DE_MARKETPLACE_ID }],
      },
    ],
  };
}

/** Plantilla de envío actual del listing en DE (UUID, legacy-template-id, o null si no tiene). */
export function currentShippingGroup(listing: unknown): string | null {
  const attr = (listing as { attributes?: Record<string, unknown> } | null)?.attributes?.[SHIPPING_GROUP_ATTR];
  const entries = (Array.isArray(attr) ? attr : []) as Array<{ value?: unknown; marketplace_id?: unknown }>;
  const de = entries.find((e) => e?.marketplace_id === DE_MARKETPLACE_ID && e.value != null)
    ?? entries.find((e) => e?.value != null);
  return de?.value != null ? String(de.value) : null;
}

/** productType del listing (primer summary), o null. */
export function listingProductType(listing: unknown): string | null {
  const summaries = (listing as { summaries?: Array<{ productType?: unknown }> } | null)?.summaries;
  const value = Array.isArray(summaries) ? summaries[0]?.productType : null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Oferta de consumidor (audience ALL) del marketplace de DE dentro de purchasable_offer. */
export function deOffer(listing: unknown): Record<string, unknown> | undefined {
  const offers = (listing as { attributes?: Record<string, unknown> } | null)?.attributes?.purchasable_offer;
  const list = (Array.isArray(offers) ? offers : []) as Array<Record<string, unknown>>;
  return list.find((o) => (o.audience ?? "ALL") === "ALL" && (o.marketplace_id ?? DE_MARKETPLACE_ID) === DE_MARKETPLACE_ID);
}

/** Precio efectivo en vivo: el de la oferta vigente si la hay, si no el precio de venta. */
export function liveEffectivePrice(listing: unknown, now = new Date()): number | null {
  const offer = deOffer(listing);
  if (!offer) return null;
  const prices = readOfferPrices(offer, now);
  return prices.sale ?? prices.price;
}

/**
 * Canal de fulfillment del listing en vivo (DEFAULT = FBM, AMAZON_EU = FBA), o null.
 * Un mismo SKU puede tener las dos entradas de `fulfillment_availability` (visto en 27 de 30 muestreados
 * con sufijo FBA): si alguna es DEFAULT, la oferta FBM existe y la fila cuenta como FBM.
 */
export function liveFulfillmentChannel(listing: unknown): string | null {
  const availability = (listing as { attributes?: Record<string, unknown> } | null)?.attributes?.fulfillment_availability;
  const codes = (Array.isArray(availability) ? availability : [])
    .map((entry) => (entry as { fulfillment_channel_code?: unknown } | null)?.fulfillment_channel_code)
    .filter((code): code is string => typeof code === "string" && code.trim() !== "")
    .map((code) => code.trim());
  if (codes.includes(FBM_CHANNEL)) return FBM_CHANNEL;
  return codes[0] ?? null;
}

/**
 * Fila del informe reconstruida con los datos en vivo, para volver a decidir justo antes del PATCH.
 * Si en vivo el atributo no está, la oferta ya usa la plantilla por defecto (la de pago): se refleja como
 * tal en vez de fiarse de la etiqueta del informe, que puede estar desfasada.
 * El precio es el de Amazon (sin overrides); los overrides los aplica decideRow encima.
 */
export function liveRow(sku: string, listing: unknown, fallback: DeReportRow, now = new Date()): DeReportRow {
  return {
    ...fallback,
    sku,
    price: liveEffectivePrice(listing, now),
    channel: liveFulfillmentChannel(listing) ?? fallback.channel,
    group: currentShippingGroup(listing) ?? PAID_SHIPPING_LABEL,
  };
}

/**
 * Decisión con el listing en vivo, para la fase de aplicación: solo se mueve si (a) el atributo sigue
 * siendo la plantilla de envío gratis, (b) el precio efectivo en vivo sigue por debajo de 35 €, (c) el
 * canal en vivo es FBM y (d) la oferta sigue teniendo precio en Amazon.
 */
export function liveDecision(
  sku: string,
  listing: unknown,
  fallback: DeReportRow,
  overrides: PriceOverrides,
  opts: { blocked?: Set<string>; now?: Date } = {},
): RowDecision {
  const now = opts.now ?? new Date();
  const live = liveRow(sku, listing, fallback, now);
  if (liveEffectivePrice(listing, now) == null) {
    return {
      action: "omitir",
      motivo: "sin oferta en vivo",
      price: null,
      source: "sin precio",
      plantillaOrigen: shippingGroupTemplate(live.group),
      plantillaDestino: "",
    };
  }
  return decideRow(live, overrides, { blocked: opts.blocked, now });
}
