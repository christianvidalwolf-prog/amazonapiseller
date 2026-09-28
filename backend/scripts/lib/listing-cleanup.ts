/**
 * Limpieza de listings muertos: SKU creados hasta 2024 que no se han vendido desde el
 * 01/01/2025 (con ningún SKU del mismo ASIN, en ningún marketplace) y sin stock FBM ni FBA.
 *
 * Antes de borrar se archiva cada SKU con lo necesario para recrear su oferta sobre el
 * mismo ASIN (el ASIN y su ficha siguen en Amazon aunque se borre la oferta).
 */
import { parseCsv } from "./fba-replication";

/** Marketplaces de la región EU en los que se busca y se borra cada SKU. */
export const CLEANUP_MARKETPLACES = {
  ES: "A1RKKUPIHCS9HS",
  DE: "A1PA6795UKMFR9",
  FR: "A13V1IB3VIYZZH",
  IT: "APJ6JRA9NG5V4",
  UK: "A1F83G8C2ARO7P",
  NL: "A1805IZSGTT6HS",
  PL: "A1C3SOZRARQ6R3",
  SE: "A2NODRKZP88ZB9",
  BE: "AMEN7PMS3EDWL",
  IE: "A28R8C7NBKEWEA",
  TR: "A33AVAJ2PDY3EV",
} as const;

export type MarketplaceCode = keyof typeof CLEANUP_MARKETPLACES;

export const codeForMarketplace = (id: string): MarketplaceCode | undefined =>
  (Object.keys(CLEANUP_MARKETPLACES) as MarketplaceCode[]).find((c) => CLEANUP_MARKETPLACES[c] === id);

/** Mismo recargo que aplica sync_daily_stock_amz.py al precio base (ES) del fichero STOCK AMZ. */
export const STOCK_FILE_PRICE_OFFSET: Partial<Record<MarketplaceCode, number>> = { ES: 0, DE: 5, FR: 6, IT: 7 };

const header = (cols: string[], name: string) => cols.findIndex((h) => h === name || h.endsWith(name));

export interface SalesIndex { skus: Set<string>; asins: Set<string> }

/** SKU y ASIN con al menos una unidad vendida (pedidos no cancelados) en un CSV de ventas_*.csv. */
export function addSales(index: SalesIndex, csvText: string): SalesIndex {
  const [cols, ...rows] = parseCsv(csvText);
  if (!cols) return index;
  const sku = header(cols, "sku"), asin = header(cols, "asin"), status = header(cols, "order-status"), qty = header(cols, "quantity");
  if ([sku, asin, status, qty].includes(-1)) throw new Error("CSV de ventas sin las columnas esperadas");
  for (const r of rows) {
    if (r[status] === "Cancelled" || !(Number(r[qty]) > 0)) continue;
    if (r[sku]) index.skus.add(r[sku].trim());
    if (r[asin]) index.asins.add(r[asin].trim());
  }
  return index;
}

export interface CatalogCandidate {
  sku: string;
  asin: string;
  openDate: string; // ISO yyyy-mm-dd
  channel: "FBA" | "FBM";
  catalogStatus: string;
  catalogQuantity: number;
  price: string;
  name: string;
}

/** "02/09/2026 16:07:58 MEST" → "2026-09-02". */
export function parseOpenDate(raw: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(raw.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Listings de catalogo_completo.csv creados hasta `maxYear` sin ventas (ni del SKU ni del
 * ASIN) y con cantidad FBM 0 en el catálogo. El stock FBA y las variaciones se comprueban
 * después en vivo, porque el catálogo no los trae.
 */
export function catalogCandidates(csvText: string, sales: SalesIndex, maxYear: number): CatalogCandidate[] {
  const [cols, ...rows] = parseCsv(csvText);
  if (!cols) return [];
  const i = {
    sku: header(cols, "seller-sku"), asin: header(cols, "asin1"), open: header(cols, "open-date"), channel: header(cols, "fulfillment-channel"),
    status: header(cols, "status"), qty: header(cols, "quantity"), price: header(cols, "price"), name: header(cols, "item-name"),
  };
  if (Object.values(i).includes(-1)) throw new Error("catalogo_completo.csv sin las columnas esperadas");
  const out: CatalogCandidate[] = [];
  for (const r of rows) {
    const sku = r[i.sku], asin = r[i.asin], openDate = parseOpenDate(r[i.open] ?? "");
    if (!sku || !openDate || Number(openDate.slice(0, 4)) > maxYear) continue;
    // Las ofertas "amzn.gr." (Grade & Resell) las gestiona Amazon, no se tocan.
    if (sku.startsWith("amzn.gr.")) continue;
    if (sales.skus.has(sku) || sales.asins.has(asin)) continue;
    const quantity = Number(r[i.qty] || 0);
    if (quantity > 0) continue;
    out.push({
      sku, asin, openDate, channel: r[i.channel] === "DEFAULT" ? "FBM" : "FBA", catalogStatus: r[i.status],
      catalogQuantity: quantity, price: r[i.price], name: r[i.name],
    });
  }
  return out;
}

/** Motivo para NO borrar un candidato tras mirarlo en vivo, o null si se puede borrar. */
export function keepReason(listing: any, fbaUnits: number): string | null {
  if (!listing) return "no existe en Amazon";
  const summaries: any[] = listing.summaries ?? [];
  if (!summaries.length) return "sin datos en ningún marketplace";
  const rels: any[] = (listing.relationships ?? []).flatMap((r: any) => r.relationships ?? []);
  const parentage = listing.attributes?.parentage_level?.[0]?.value;
  if (parentage === "parent" || rels.some((r) => (r.childSkus ?? []).length)) return "padre de variación";
  const fbm = (listing.fulfillmentAvailability ?? []).reduce((n: number, f: any) => n + (f.fulfillmentChannelCode === "DEFAULT" ? Number(f.quantity ?? 0) : 0), 0);
  if (fbm > 0) return `stock FBM ${fbm}`;
  if (fbaUnits > 0) return `inventario FBA ${fbaUnits}`;
  if (summaries.some((s) => (s.status ?? []).includes("BUYABLE"))) return "se puede comprar en algún marketplace";
  return null;
}

/** Contenido de la ficha: pertenece al ASIN, no hace falta para recrear la oferta. */
const CONTENT_ATTRIBUTES = /^(bullet_point|product_description|generic_keyword|.*image_locator.*|image_locator_.*)$/;

export interface ArchiveRecord {
  version: 1;
  sku: string;
  asin: string;
  channel: "FBA" | "FBM";
  name: string;
  openDate: string;
  status: "archived" | "deleted" | "reactivated";
  archivedAt: string;
  deletedAt?: string;
  reactivatedAt?: string;
  marketplaces: Array<{ code: MarketplaceCode; productType: string; status: string[]; createdDate?: string; price: number | null }>;
  /** Atributos del listing (sin el contenido de la ficha), para copiar los que Amazon pida al recrear. */
  attributes: Record<string, unknown[]>;
  deletions?: Array<{ code: MarketplaceCode; result: string; submissionId?: string; detail?: string }>;
  reactivations?: Array<{ code: MarketplaceCode; result: string; submissionId?: string; detail?: string }>;
}

export function archiveRecord(c: CatalogCandidate, listing: any, now: string): ArchiveRecord {
  const attributes: Record<string, unknown[]> = {};
  for (const [k, v] of Object.entries(listing.attributes ?? {})) if (!CONTENT_ATTRIBUTES.test(k)) attributes[k] = v as unknown[];
  const marketplaces = (listing.summaries ?? []).flatMap((s: any) => {
    const code = codeForMarketplace(s.marketplaceId);
    return code ? [{ code, productType: s.productType, status: s.status ?? [], createdDate: s.createdDate, price: offerPrice(attributes, s.marketplaceId) }] : [];
  });
  return { version: 1, sku: c.sku, asin: c.asin, channel: c.channel, name: c.name, openDate: c.openDate, status: "archived", archivedAt: now, marketplaces, attributes };
}

/** Precio de venta (audience ALL) de un marketplace en los atributos archivados. */
export function offerPrice(attributes: Record<string, unknown[]>, marketplaceId: string): number | null {
  const offer = (attributes.purchasable_offer as any[] | undefined)?.find(
    (o) => (o.audience ?? "ALL") === "ALL" && (o.marketplace_id ?? marketplaceId) === marketplaceId,
  );
  const v = offer?.our_price?.[0]?.schedule?.[0]?.value_with_tax;
  return v == null ? null : Number(v);
}

/** Valor de un atributo archivado para un marketplace (o el primero sin marketplace). */
function attrFor(attributes: Record<string, unknown[]>, name: string, marketplaceId: string): any[] | undefined {
  const values = (attributes[name] as any[] | undefined) ?? [];
  const own = values.filter((v) => v.marketplace_id === marketplaceId);
  const picked = own.length ? own : values.filter((v) => !v.marketplace_id).slice(0, 1);
  return picked.length ? picked.map((v) => ({ ...v, marketplace_id: marketplaceId })) : undefined;
}

/** Payload LISTING_OFFER_ONLY para volver a crear la oferta archivada sobre su ASIN. */
export function reactivationPayload(rec: ArchiveRecord, code: MarketplaceCode, price: number, quantity: number) {
  const mid = CLEANUP_MARKETPLACES[code];
  const productType = rec.marketplaces.find((m) => m.code === code)?.productType ?? rec.marketplaces[0]?.productType ?? "PRODUCT";
  const shipping = rec.channel === "FBM" ? attrFor(rec.attributes, "merchant_shipping_group", mid) : undefined;
  return {
    productType,
    requirements: "LISTING_OFFER_ONLY" as const,
    attributes: {
      condition_type: attrFor(rec.attributes, "condition_type", mid) ?? [{ value: "new_new", marketplace_id: mid }],
      merchant_suggested_asin: [{ value: rec.asin, marketplace_id: mid }],
      purchasable_offer: [{ currency: "EUR", marketplace_id: mid, audience: "ALL", our_price: [{ schedule: [{ value_with_tax: price }] }] }],
      fulfillment_availability: [
        rec.channel === "FBM"
          ? { fulfillment_channel_code: "DEFAULT", quantity, lead_time_to_ship_max_days: 2, marketplace_id: mid }
          : { fulfillment_channel_code: "AMAZON_EU", marketplace_id: mid },
      ],
      ...(shipping ? { merchant_shipping_group: shipping } : {}),
    },
  };
}

export interface StockFileRow { sku: string; price: number | null; quantity: number }

/**
 * Lee un STOCK AMZ exportado a texto (tabulador o ";", coma o punto decimal), con cabecera
 * sku / price / quantity como el fichero diario.
 */
export function parseStockFile(text: string): Map<string, StockFileRow> {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const rows = parseCsv(text, firstLine.includes("\t") ? "\t" : ";");
  const [cols, ...data] = rows;
  const out = new Map<string, StockFileRow>();
  if (!cols) return out;
  const norm = cols.map((c) => c.trim().toLowerCase());
  const sku = norm.findIndex((c) => c.endsWith("sku")), price = norm.indexOf("price"), qty = norm.indexOf("quantity");
  if (sku === -1 || qty === -1) throw new Error("Fichero de stock sin columnas sku/quantity");
  const num = (v: string | undefined) => (v && v.trim() ? Number(v.trim().replace(",", ".")) : NaN);
  for (const r of data) {
    const s = r[sku]?.trim();
    if (!s) continue;
    const p = price === -1 ? NaN : num(r[price]);
    const q = num(r[qty]);
    out.set(s, { sku: s, price: Number.isFinite(p) ? p : null, quantity: Number.isFinite(q) ? Math.trunc(q) : 0 });
  }
  return out;
}

/**
 * Marketplaces donde la reactivación automática recrea ofertas: los que mantiene la
 * sincronización diaria de stock (precio base del fichero + recargo del país).
 */
export const AUTO_REACTIVATE_MARKETPLACES: MarketplaceCode[] = ["ES", "DE", "FR", "IT"];

/** Filas de la copia de stock en Supabase (items de sync_daily_stock_amz.py) por SKU. */
export function stockFromSnapshotItems(items: Array<Record<string, unknown>>): Map<string, StockFileRow> {
  const out = new Map<string, StockFileRow>();
  for (const it of items) {
    const sku = String(it.sku ?? "").trim();
    if (!sku) continue;
    const price = it.price == null || it.price === "" ? NaN : Number(it.price);
    const quantity = Number(it.quantity ?? 0);
    out.set(sku, { sku, price: Number.isFinite(price) && price > 0 ? price : null, quantity: Number.isFinite(quantity) ? Math.trunc(quantity) : 0 });
  }
  return out;
}

/** Precio con el que se recrea la oferta: base del fichero de stock + recargo del país, o el archivado. */
export function reactivationPrice(rec: ArchiveRecord, code: MarketplaceCode, stock?: StockFileRow): number | null {
  const offset = STOCK_FILE_PRICE_OFFSET[code];
  if (rec.channel === "FBM" && stock?.price != null && offset != null) return Number((stock.price + offset).toFixed(2));
  return rec.marketplaces.find((m) => m.code === code)?.price ?? null;
}
