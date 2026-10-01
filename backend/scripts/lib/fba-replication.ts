import { fixedPriceForSku } from "../../src/lib/priceOverrides";

/**
 * Regla de réplica de ofertas FBA: los FBA dados de alta en España se publican
 * también en DE/FR/IT, con precio DE = ES y FR/IT = ES + 2 €.
 *
 * La regla solo gestiona (crea y mantiene sincronizado el precio de) dos tipos de oferta:
 * las que crea ella misma y las de SKU dados de alta en ES después de la línea base.
 * Las ofertas que ya existían en DE/FR/IT al fijar la línea base no se tocan.
 */

export const REPLICATION_TARGETS = [
  { code: "DE", add: 0 },
  { code: "FR", add: 2 },
  { code: "IT", add: 2 },
] as const;

export type TargetCode = (typeof REPLICATION_TARGETS)[number]["code"];

/** Excepciones de precio que prevalecen sobre la regla ES → DE/FR/IT. */
export interface ReplicationState {
  version: 1;
  /** SKU FBA de España existentes al activar la regla; sus ofertas previas en otros países no se tocan. */
  baseline: string[];
  baselineAt: string;
  /** Ofertas gestionadas, con clave `${sku}|${code}`. */
  managed: Record<string, { origin: "created" | "new-sku"; since: string }>;
}

export function targetPrice(esPrice: number, code: TargetCode): number {
  const add = REPLICATION_TARGETS.find((t) => t.code === code)!.add;
  return Number((esPrice + add).toFixed(2));
}

/** Precio objetivo incluyendo las excepciones específicas por SKU. */
export function targetPriceForSku(esPrice: number, sku: string, code: TargetCode): number {
  const marketplaceId = code === "DE" ? "A1PA6795UKMFR9" : code === "FR" ? "A13V1IB3VIYZZH" : "APJ6JRA9NG5V4";
  return fixedPriceForSku(sku, marketplaceId, targetPrice(esPrice, code));
}

export const managedKey = (sku: string, code: TargetCode) => `${sku}|${code}`;

/**
 * Parser CSV (RFC 4180) con delimitador configurable: respeta campos entre comillas
 * con delimitadores, comillas escapadas ("") y saltos de línea. catalogo_completo.csv
 * tiene descripciones así, y separar por líneas y por ";" desalinea esas filas.
 */
export function parseCsv(text: string, delimiter = ";"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

export interface EsFbaListing { sku: string; asin: string; status: string }

/** Listings FBA (AMAZON_EU) de catalogo_completo.csv, excluidos los Incomplete. */
export function esFbaListingsFromCatalog(csvText: string): EsFbaListing[] {
  const [header, ...rows] = parseCsv(csvText);
  if (!header) return [];
  // La primera cabecera puede llevar BOM (o su versión mal decodificada "ï»¿").
  const idx = (name: string) => header.findIndex((h) => h === name || h.endsWith(name));
  const sku = idx("seller-sku"), asin = idx("asin1"), channel = idx("fulfillment-channel"), status = idx("status");
  if ([sku, asin, channel, status].includes(-1)) throw new Error("catalogo_completo.csv sin las columnas esperadas");
  return rows
    .filter((r) => r[channel] === "AMAZON_EU" && r[status] !== "Incomplete" && r[sku])
    .map((r) => ({ sku: r[sku], asin: r[asin], status: r[status] }));
}

export interface WorkItem {
  sku: string;
  asin: string;
  /** Países donde solo se crea la oferta si falta (SKU de la línea base). */
  createOnly: TargetCode[];
  /** Países gestionados: crear si falta y sincronizar precio si existe. */
  manage: TargetCode[];
}

/**
 * Decide qué revisar en esta ejecución. En la primera ejecución fija la línea base
 * (todos los FBA actuales de ES) y devuelve el estado nuevo.
 */
export function planRun(state: ReplicationState | null, listings: EsFbaListing[], now: string): { state: ReplicationState; work: WorkItem[] } {
  const next: ReplicationState = state
    ? { ...state, managed: { ...state.managed } }
    : { version: 1, baseline: [...new Set(listings.map((l) => l.sku))].sort(), baselineAt: now, managed: {} };
  const baseline = new Set(next.baseline);
  const codes = REPLICATION_TARGETS.map((t) => t.code);
  const work: WorkItem[] = [];
  const seen = new Set<string>();
  for (const l of listings) {
    if (seen.has(l.sku)) continue;
    seen.add(l.sku);
    if (!baseline.has(l.sku)) {
      for (const c of codes) next.managed[managedKey(l.sku, c)] ??= { origin: "new-sku", since: now };
    }
    const manage = codes.filter((c) => next.managed[managedKey(l.sku, c)]);
    // Huecos de la línea base: el runner solo los rellena si el listing de ES se puede comprar
    // (estado en vivo; el status del CSV puede estar desactualizado).
    const createOnly = baseline.has(l.sku) ? codes.filter((c) => !manage.includes(c)) : [];
    if (manage.length || createOnly.length) work.push({ sku: l.sku, asin: l.asin, createOnly, manage });
  }
  return { state: next, work };
}

/** Atributos de cumplimiento que Amazon suele exigir al crear una oferta y que se copian de ES si faltan. */
export function copyAttributesFor(esAttributes: Record<string, unknown[]> | undefined, names: string[], marketplaceId: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const name of names) {
    const values = esAttributes?.[name];
    if (Array.isArray(values) && values.length) {
      out[name] = values.map((v) => ({ ...(v as Record<string, unknown>), marketplace_id: marketplaceId }));
    }
  }
  return out;
}

export function offerOnlyPayload(params: { productType: string; asin: string; marketplaceId: string; price: number; extra?: Record<string, unknown[]> }) {
  const { productType, asin, marketplaceId, price, extra } = params;
  return {
    productType,
    requirements: "LISTING_OFFER_ONLY" as const,
    attributes: {
      condition_type: [{ value: "new_new", marketplace_id: marketplaceId }],
      merchant_suggested_asin: [{ value: asin, marketplace_id: marketplaceId }],
      purchasable_offer: [{ currency: "EUR", marketplace_id: marketplaceId, audience: "ALL", our_price: [{ schedule: [{ value_with_tax: price }] }] }],
      fulfillment_availability: [{ fulfillment_channel_code: "AMAZON_EU", marketplace_id: marketplaceId }],
      ...extra,
    },
  };
}
