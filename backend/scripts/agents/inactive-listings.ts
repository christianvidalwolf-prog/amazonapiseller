/**
 * Equipo de agentes de listings inactivos (FBA con stock y sin BUYABLE), todos los días y en todos
 * los países configurados (por defecto ES/DE/FR/IT).
 *
 *   1. Escáner   → inventario FBA con unidades vendibles + estado/issues de cada listing.
 *   2. Triaje    → `src/lib/inactive-case.ts` decide el arreglo (precio, oferta que falta, GPSR)
 *                  o el escalado a Seller Central (documentos, marca, categoría…).
 *   3. Corrector → aplica el arreglo por API con un tope por ejecución; simula antes de crear ofertas.
 *   4. Verificador → relee el estado, cierra los casos que ya no salen y deja de reintentar los que
 *                  fallan `MAX_ATTEMPTS` veces (pasan al informe de Seller Central).
 *
 * Estado e informe en Supabase (`rules:inactive-listings:state` y `:last-run`); el informe también se
 * escribe en `alerts:fba-inactive:last-run`, el formato que ya lee el resto del proyecto.
 *
 * Env:
 *   INACTIVE_AGENTS_APPLY=1       → escribe en Amazon (si no, solo valida; por defecto NO escribe).
 *   INACTIVE_AGENTS_COUNTRIES     → países (por defecto ES,DE,FR,IT).
 *   INACTIVE_AGENTS_MAX_FIXES     → tope de arreglos por ejecución (por defecto 60).
 *   INACTIVE_AGENTS_MAX_ATTEMPTS  → intentos por caso antes de escalar (por defecto 2).
 *   INACTIVE_AGENTS_PREVIEW=0     → no validar con VALIDATION_PREVIEW antes de crear ofertas/GPSR.
 *   INACTIVE_AGENTS_EMAIL=0       → no enviar email.
 *   GPSR_MANUFACTURER_EMAIL       → email del fabricante para GPSR (por defecto el de la cuenta).
 *   FIXED_PRICES_CSV              → fixed_prices.csv (por defecto ../fixed_prices.csv).
 *   GMAIL_USER / GMAIL_APP_PASSWORD / ALERT_EMAIL_TO → email del informe.
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY → estado e informes.
 */
import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import { env } from "../../src/config/env";
import {
  caseKey,
  classifyCase,
  planFixes,
  type FixAction,
  type InactiveCase,
  type PlannedCase,
} from "../../src/lib/inactive-case";
import {
  FBA_COUNTRY_OFFSET,
  readBusinessPrice,
  readOfferPrices,
  suppressedBelowMinFix,
  priceBoundsFix,
  withBounds,
  withoutStaleSales,
  parseFixedPrices,
  halfPrice,
} from "../../src/lib/priceBounds";
import { EU_MARKETPLACES } from "../../src/modules/account-health/account-health.service";
import { SpApiClient } from "../../src/spapi/client";
import { getInventorySummaries } from "../../src/spapi/endpoints/fbaInventory";
import { getListingsItem, patchListingsItem, previewListingsItem, putListingsItem } from "../../src/spapi/endpoints/listingsItems";
import { offerOnlyPayload } from "../lib/fba-replication";
import { isGradeAndResell, isIgnored, parseIgnoreRules } from "../lib/fba-watch";

const APPLY = process.env.INACTIVE_AGENTS_APPLY === "1";
const PREVIEW = process.env.INACTIVE_AGENTS_PREVIEW !== "0";
/** Ejecuta los correctores pero se queda en la validación previa (no envía nada a Amazon). */
const PREVIEW_ONLY = process.env.INACTIVE_AGENTS_PREVIEW_ONLY === "1";
const SEND_EMAIL = process.env.INACTIVE_AGENTS_EMAIL !== "0";
const MAX_FIXES = Number(process.env.INACTIVE_AGENTS_MAX_FIXES ?? 60);
const MAX_ATTEMPTS = Number(process.env.INACTIVE_AGENTS_MAX_ATTEMPTS ?? 2);
const ONLY = new Set(
  (process.env.INACTIVE_AGENTS_SKUS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const GPSR_EMAIL = process.env.GPSR_MANUFACTURER_EMAIL?.trim() || "vidalregals@gmail.com";
const ISSUE_LOCALE = "es_ES";
const EMAIL_TO = process.env.ALERT_EMAIL_TO?.trim() || "christianvidalwolf@gmail.com";

const ALL_COUNTRIES = ["ES", "DE", "FR", "IT"] as const;
const COUNTRIES = (process.env.INACTIVE_AGENTS_COUNTRIES ?? "ES,DE,FR,IT")
  .split(",")
  .map((c) => c.trim().toUpperCase())
  .filter((c) => (ALL_COUNTRIES as readonly string[]).includes(c));

const FIXED_CSV = process.env.FIXED_PRICES_CSV ?? path.resolve(process.cwd(), "..", "fixed_prices.csv");
const fixedPrices = fs.existsSync(FIXED_CSV) ? parseFixedPrices(fs.readFileSync(FIXED_CSV, "utf-8")) : new Map<string, number>();
const BLOCKED_FILE = path.resolve(process.cwd(), "..", "blocked_skus.txt");
const IGNORE_FILE = process.env.FBA_WATCH_IGNORE_FILE ?? path.resolve(process.cwd(), "..", "fba_watch_ignore.txt");
const ignoreRules = fs.existsSync(IGNORE_FILE) ? parseIgnoreRules(fs.readFileSync(IGNORE_FILE, "utf-8")) : [];
const BLOCKED = new Set(
  fs.existsSync(BLOCKED_FILE)
    ? fs
        .readFileSync(BLOCKED_FILE, "utf-8")
        .split(/\r?\n/)
        .map((l) => l.trim().toUpperCase())
        .filter((l) => l && !l.startsWith("#"))
    : [],
);

const STATE_KEY = "rules:inactive-listings:state";
const REPORT_KEY = "rules:inactive-listings:last-run";
const WATCH_KEY = "alerts:fba-inactive:last-run";

const supabaseUrl = (() => {
  const raw = (process.env.SUPABASE_URL ?? "").trim();
  return (raw && !/^https?:\/\//.test(raw) ? `https://${raw}` : raw).replace(/\/+$/, "");
})();
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

const client = new SpApiClient({ credentials: env.spApi });
const now = new Date();
const isNotFound = (e: unknown) => /NOT_FOUND|not found|404/i.test(String(e));
const round2 = (n: number) => Math.round(n * 100) / 100;

// ───────────────────────────── Supabase ─────────────────────────────

async function readJson<T>(key: string): Promise<T | null> {
  if (!supabaseUrl || !supabaseKey) return null;
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/snapshots?key=eq.${encodeURIComponent(key)}&select=data&limit=1`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ data: T }>;
    return rows[0]?.data ?? null;
  } catch {
    return null;
  }
}

async function writeJson(key: string, data: unknown): Promise<void> {
  if (!supabaseUrl || !supabaseKey) return;
  const res = await fetch(`${supabaseUrl}/rest/v1/snapshots?on_conflict=key`, {
    method: "POST",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase upsert ${key} ${res.status}: ${await res.text()}`);
}

// ───────────────────────────── Escáner ─────────────────────────────

interface AttemptState {
  count: number;
  action: FixAction;
  lastAt: string;
  lastResult: string;
  units: number;
}

interface AgentState {
  attempts: Record<string, AttemptState>;
  updatedAt: string;
}

interface ScanResult {
  cases: InactiveCase[];
  conStock: Record<string, number>;
  scannedCountries: Set<string>;
  errors: Array<{ country: string; sku?: string; detail: string }>;
  /** Casos sin arreglo por API que el usuario ya silenció en `fba_watch_ignore.txt`. */
  ignored: Array<{ sku: string; pais: string; motivos: string[] }>;
}

async function readListing(sku: string, country: string, data: string[]): Promise<any | null> {
  try {
    return await getListingsItem(client, {
      sellerId: env.sellerId,
      sku,
      marketplaceIds: [EU_MARKETPLACES[country].id],
      includedData: data,
      issueLocale: ISSUE_LOCALE,
    });
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

const midOf = (country: string) => EU_MARKETPLACES[country].id;

function offerState(attributes: Record<string, any[] | undefined> | undefined, mid: string, at: Date) {
  const offers = (attributes?.purchasable_offer ?? []) as Array<Record<string, any>>;
  const mine = offers.filter((o) => (o.marketplace_id ?? mid) === mid);
  const normal = mine.find((o) => (o.audience ?? "ALL") === "ALL");
  const business = mine.find((o) => o.audience === "B2B");
  const prices = readOfferPrices(normal, at);
  const expiredSale = ((normal?.discounted_price as any[]) ?? []).some((entry) =>
    (entry?.schedule ?? []).some((s: any) => s?.end_at && Date.parse(s.end_at) <= at.getTime()),
  );
  const endAt = normal?.end_at?.value as string | undefined;
  return {
    hasNormal: Boolean(normal),
    hasPrice: prices.price != null,
    hasBusiness: Boolean(business),
    hasExpiredSale: expiredSale || Boolean(endAt && Date.parse(endAt) <= at.getTime()),
  };
}

async function fbaStock(marketplaceId: string): Promise<Map<string, { asin: string; units: number }>> {
  const stock = new Map<string, { asin: string; units: number }>();
  let nextToken: string | undefined;
  do {
    const page: any = await getInventorySummaries(client, { marketplaceIds: [marketplaceId], nextToken });
    for (const s of page.payload?.inventorySummaries ?? []) {
      const units = s.inventoryDetails?.fulfillableQuantity ?? 0;
      if (units > 0) stock.set(s.sellerSku, { asin: s.asin, units });
    }
    nextToken = page.pagination?.nextToken;
  } while (nextToken);
  return stock;
}

async function scan(): Promise<ScanResult> {
  const result: ScanResult = { cases: [], conStock: {}, scannedCountries: new Set(), errors: [], ignored: [] };

  for (const country of COUNTRIES) {
    let stock: Map<string, { asin: string; units: number }>;
    try {
      stock = await fbaStock(midOf(country));
    } catch (e) {
      result.errors.push({ country, detail: `inventario FBA: ${String(e).slice(0, 200)}` });
      continue;
    }
    result.scannedCountries.add(country);
    result.conStock[country] = stock.size;

    for (const [sku, s] of stock) {
      if (BLOCKED.has(sku.toUpperCase())) continue;
      if (ONLY.size && !ONLY.has(sku)) continue;
      try {
        const listing = await readListing(sku, country, ["summaries", "issues", "attributes"]);
        const summary = listing?.summaries?.[0];
        const status: string[] = summary?.status ?? [];
        if (summary && status.includes("BUYABLE")) continue;
        // Los amzn.gr.* (devoluciones que Amazon revende) solo existen donde Amazon los crea.
        if (!summary && isGradeAndResell(sku)) continue;
        const issues = (listing?.issues ?? []) as InactiveCase["issues"];
        // Casos que el usuario silenció (sin arreglo por API): no se tocan ni se avisan.
        const motivos = issues.filter((i) => i.severity === "ERROR").map((i) => `${i.code}: ${i.message}`);
        if (isIgnored({ sku, pais: country, motivos }, ignoreRules)) {
          result.ignored.push({ sku, pais: country, motivos });
          continue;
        }
        result.cases.push({
          sku,
          country,
          asin: (summary?.asin as string | undefined) ?? s.asin ?? null,
          units: s.units,
          status,
          issues,
          exists: Boolean(summary),
          productType: (summary?.productType as string | undefined) ?? null,
          offer: offerState(listing?.attributes, midOf(country), now),
        });
      } catch (e) {
        result.errors.push({ country, sku, detail: String(e).slice(0, 200) });
      }
    }
  }
  return result;
}

// ───────────────────────────── Precio de referencia ─────────────────────────────

const priceCache = new Map<string, number | null>();

/** Precio normal que la oferta tiene en un país (null si no hay oferta o no tiene importe). */
async function offerPrice(sku: string, country: string): Promise<number | null> {
  const key = `${sku}|${country}`;
  if (priceCache.has(key)) return priceCache.get(key) ?? null;
  let price: number | null = null;
  try {
    const listing = await readListing(sku, country, ["attributes"]);
    const mid = midOf(country);
    const normal = ((listing?.attributes?.purchasable_offer ?? []) as Array<Record<string, any>>).find(
      (o) => (o.audience ?? "ALL") === "ALL" && (o.marketplace_id ?? mid) === mid,
    );
    price = readOfferPrices(normal, now).price;
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  priceCache.set(key, price);
  return price;
}

/**
 * Precio con el que crear/rellenar la oferta de un país: `fixed_prices.csv` manda; si no, el precio
 * que ya tenga ese país; si no, se deduce de otro país con la regla por país (DE = ES, FR = IT = ES + 2).
 */
async function referencePrice(sku: string, country: string): Promise<number | null> {
  const fixed = fixedPrices.get(`${sku}|${country}`);
  if (fixed != null) return fixed;
  const own = await offerPrice(sku, country);
  if (own != null) return own;
  const targetOffset = FBA_COUNTRY_OFFSET[country];
  if (targetOffset == null) return null;
  for (const source of ALL_COUNTRIES) {
    if (source === country) continue;
    const sourceOffset = FBA_COUNTRY_OFFSET[source];
    if (sourceOffset == null) continue;
    const price = await offerPrice(sku, source);
    if (price != null) return round2(price - sourceOffset + targetOffset);
  }
  return null;
}

// ───────────────────────────── Corrector ─────────────────────────────

interface Outcome {
  result: string;
  detail?: string;
}

const errorsOf = (res: any) => (res?.issues ?? []).filter((i: any) => i.severity === "ERROR");
const describeIssues = (res: any) =>
  errorsOf(res)
    .map((i: any) => `${i.code} ${i.message}`)
    .join(" | ")
    .slice(0, 300);

function perMarketplaceOffer(offers: Array<Record<string, any>>, mid: string): Array<Record<string, any>> {
  const mine = offers
    .filter((o) => (o.marketplace_id ?? mid) === mid)
    .map((o) => ({ ...o, marketplace_id: mid }));
  return mine;
}

async function patchOffer(sku: string, country: string, listing: any, value: Array<Record<string, any>>): Promise<Outcome> {
  const res: any = await patchListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [midOf(country)] }, {
    productType: (listing?.summaries?.[0]?.productType as string | undefined) ?? "PRODUCT",
    patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: value as unknown[] }],
  });
  return res.status === "ACCEPTED"
    ? { result: "aplicado" }
    : { result: "rechazado", detail: describeIssues(res) || String(res.status) };
}

/** 18155 / oferta caducada / 18639: límites de precio y limpieza de promociones vencidas. */
async function fixBounds(item: InactiveCase): Promise<Outcome> {
  const mid = midOf(item.country);
  const listing = await readListing(item.sku, item.country, ["attributes", "summaries"]);
  if (!listing) return { result: "sin datos", detail: "el SKU no existe en el marketplace" };
  const offers = (listing.attributes?.purchasable_offer ?? []) as Array<Record<string, any>>;
  const mine = perMarketplaceOffer(offers, mid);
  const normal = mine.find((o) => (o.audience ?? "ALL") === "ALL");
  if (!normal) return { result: "sin datos", detail: "no hay oferta normal (la rellena el siguiente paso)" };

  const business = readBusinessPrice(offers, mid);
  const prices = { ...readOfferPrices(normal, now), business };
  const bounds = item.issues.some((i) => i.code === "18155") ? suppressedBelowMinFix(prices) : priceBoundsFix(prices);
  const value = mine.map((o) => {
    if ((o.audience ?? "ALL") !== "ALL") return o;
    const cleaned = withBounds(withoutStaleSales(o, now), bounds);
    return { ...cleaned, currency: o.currency ?? "EUR", audience: "ALL", marketplace_id: mid };
  });
  // Solo cuenta como cambio lo que el arreglo toca: importes, límites y fin de oferta.
  const core = (o: Record<string, any>) =>
    JSON.stringify({ p: o.our_price, d: o.discounted_price, min: o.minimum_seller_allowed_price, max: o.maximum_seller_allowed_price, end: o.end_at });
  const normalOffers = (list: Array<Record<string, any>>) => list.filter((o) => (o.audience ?? "ALL") === "ALL");
  if (normalOffers(value).map(core).join("|") === normalOffers(mine).map(core).join("|")) {
    return { result: "sin cambio", detail: "la oferta ya cumple la regla" };
  }
  return patchOffer(item.sku, item.country, listing, value);
}

/** Oferta sin precio normal (solo B2B o `our_price` vacío): poner el precio del país. */
async function fixFillPrice(item: InactiveCase): Promise<Outcome> {
  const mid = midOf(item.country);
  const listing = await readListing(item.sku, item.country, ["attributes", "summaries"]);
  if (!listing) return { result: "sin datos", detail: "el SKU no existe en el marketplace" };
  const price = await referencePrice(item.sku, item.country);
  if (price == null) return { result: "sin datos", detail: "sin precio de referencia (ni fijo, ni en ES, ni en otro país)" };

  const offers = (listing.attributes?.purchasable_offer ?? []) as Array<Record<string, any>>;
  const mine = perMarketplaceOffer(offers, mid);
  const business = readBusinessPrice(offers, mid);
  const normal = mine.find((o) => (o.audience ?? "ALL") === "ALL");
  const bounds = suppressedBelowMinFix({ price, sale: null, min: null, max: null, business });

  let value: Array<Record<string, any>>;
  if (normal) {
    const cleaned = withoutStaleSales(normal, now);
    const priced = { ...cleaned, currency: normal.currency ?? "EUR", audience: "ALL", marketplace_id: mid, our_price: [{ schedule: [{ value_with_tax: price }] }] };
    value = mine.map((o) => (o === normal ? withBounds(priced, bounds) : o));
    if (JSON.stringify(value) === JSON.stringify(mine)) return { result: "sin cambio", detail: "ya tenía precio normal" };
  } else {
    const entry = {
      currency: "EUR",
      marketplace_id: mid,
      audience: "ALL",
      our_price: [{ schedule: [{ value_with_tax: price }] }],
      minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: halfPrice(business != null ? Math.min(price, business) : price) }] }],
    };
    value = [...mine, entry];
  }
  const outcome = await patchOffer(item.sku, item.country, listing, value);
  return { ...outcome, detail: outcome.detail ?? `precio ${price}` };
}

/** Stock en el país pero el SKU no existe allí: crear la oferta sobre el mismo ASIN. */
async function fixCreateOffer(item: InactiveCase): Promise<Outcome> {
  const mid = midOf(item.country);
  const asin = item.asin;
  if (!asin) return { result: "sin datos", detail: "sin ASIN con el que crear la oferta" };
  const price = await referencePrice(item.sku, item.country);
  if (price == null) return { result: "sin datos", detail: "sin precio de referencia para crear la oferta" };

  let productType = "PRODUCT";
  for (const source of ALL_COUNTRIES) {
    if (source === item.country) continue;
    const listing = await readListing(item.sku, source, ["summaries"]);
    const pt = listing?.summaries?.[0]?.productType as string | undefined;
    if (pt) {
      productType = pt;
      break;
    }
  }

  const extra: Record<string, unknown[]> = {
    supplier_declared_dg_hz_regulation: [{ value: "not_applicable", marketplace_id: mid }],
    batteries_required: [{ value: false, marketplace_id: mid }],
  };
  if (item.country !== "ES") {
    extra.gpsr_manufacturer_reference = [{ gpsr_manufacturer_email_address: GPSR_EMAIL, marketplace_id: mid }];
    extra.gpsr_safety_attestation = [{ value: true, marketplace_id: mid }];
  }
  const body = offerOnlyPayload({ productType, asin, marketplaceId: mid, price, extra });

  if (PREVIEW) {
    const preview: any = await previewListingsItem(client, { sellerId: env.sellerId, sku: item.sku, marketplaceIds: [mid] }, body as any);
    if (errorsOf(preview).length) return { result: "preview rechazado", detail: describeIssues(preview) };
  }
  if (PREVIEW_ONLY) return { result: "preview ok", detail: "sin enviar (PREVIEW_ONLY)" };
  const res: any = await putListingsItem(client, { sellerId: env.sellerId, sku: item.sku, marketplaceIds: [mid] }, body as any);
  return res.status === "ACCEPTED"
    ? { result: "aplicado", detail: `oferta creada a ${price} €` }
    : { result: "rechazado", detail: describeIssues(res) || String(res.status) };
}

/** 100632 GPSR: referencia del fabricante y certificación de seguridad. */
async function fixGpsr(item: InactiveCase): Promise<Outcome> {
  const mid = midOf(item.country);
  const listing = await readListing(item.sku, item.country, ["summaries"]);
  if (!listing) return { result: "sin datos", detail: "el SKU no existe en el marketplace" };
  const body = {
    productType: (listing.summaries?.[0]?.productType as string | undefined) ?? "PRODUCT",
    patches: [
      { op: "replace" as const, path: "/attributes/gpsr_manufacturer_reference", value: [{ gpsr_manufacturer_email_address: GPSR_EMAIL, marketplace_id: mid }] },
      { op: "replace" as const, path: "/attributes/gpsr_safety_attestation", value: [{ value: true, marketplace_id: mid }] },
    ],
  };
  const send = (preview: boolean) =>
    client.request<any>({
      method: "PATCH",
      path: `/listings/2021-08-01/items/${env.sellerId}/${encodeURIComponent(item.sku)}`,
      query: { marketplaceIds: mid, issueLocale: ISSUE_LOCALE, ...(preview ? { mode: "VALIDATION_PREVIEW" } : {}) },
      body,
      rateLimitKey: "listingsItems.patchListingsItem",
    });
  if (PREVIEW) {
    const preview = await send(true);
    if (errorsOf(preview).length) return { result: "preview rechazado", detail: describeIssues(preview) };
  }
  if (PREVIEW_ONLY) return { result: "preview ok", detail: "sin enviar (PREVIEW_ONLY)" };
  const res = await send(false);
  return res.status === "ACCEPTED" ? { result: "aplicado" } : { result: "rechazado", detail: describeIssues(res) || String(res.status) };
}

async function applyFix(item: InactiveCase, action: FixAction): Promise<Outcome> {
  switch (action) {
    case "bounds":
      return fixBounds(item);
    case "fill-price":
      return fixFillPrice(item);
    case "create-offer":
      return fixCreateOffer(item);
    case "gpsr":
      return fixGpsr(item);
    default:
      return { result: "sin acción" };
  }
}

/** Estado inmediato tras el arreglo (Amazon puede tardar en recalcular; la verificación real es la del día siguiente). */
async function immediateStatus(item: InactiveCase): Promise<string[]> {
  try {
    const listing = await readListing(item.sku, item.country, ["summaries"]);
    return (listing?.summaries?.[0]?.status as string[] | undefined) ?? [];
  } catch {
    return [];
  }
}

// ───────────────────────────── Email ─────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cell = "padding:6px 8px;border-bottom:1px solid #ddd;vertical-align:top";

const ACTION_LABEL: Record<FixAction, string> = {
  bounds: "límites de precio",
  "fill-price": "precio normal",
  "create-offer": "crear oferta",
  gpsr: "GPSR",
  wait: "esperar (revisión de Amazon)",
  escalate: "Seller Central",
  ignore: "ignorar",
};

function reportHtml(params: {
  at: string;
  scanned: ScanResult;
  applied: Array<{ item: InactiveCase; action: FixAction; outcome: Outcome; status: string[] }>;
  manual: PlannedCase[];
  resolved: Array<{ key: string; action: FixAction }>;
  pendingNext: number;
}): string {
  const { at, scanned, applied, manual, resolved, pendingNext } = params;
  const ok = applied.filter((a) => a.outcome.result === "aplicado").length;
  const failed = applied.length - ok;

  const appliedRows = applied
    .map(
      (a) =>
        `<tr><td style="${cell}">${esc(a.item.sku)}</td><td style="${cell}">${a.item.country}</td><td style="${cell}">${esc(ACTION_LABEL[a.action])}</td><td style="${cell}">${esc(a.outcome.result)}${a.outcome.detail ? `<br><span style="color:#666;font-size:12px">${esc(a.outcome.detail)}</span>` : ""}</td><td style="${cell}">${a.status.length ? esc(a.status.join(", ")) : "—"}</td></tr>`,
    )
    .join("");

  const manualRows = manual
    .map(
      (p) =>
        `<tr><td style="${cell}">${esc(p.item.sku)}</td><td style="${cell}">${p.item.country}</td><td style="${cell};text-align:right">${p.item.units}</td><td style="${cell}">${esc(p.classification.reason)}${p.attempts ? `<br><span style="color:#666;font-size:12px">${p.attempts} intento(s) previo(s)</span>` : ""}</td></tr>`,
    )
    .join("");

  const head = (cols: string[]) => cols.map((h) => `<th style="${cell};text-align:left;background:#f4f4f4">${h}</th>`).join("");
  const table = (cols: string[], rows: string, empty: string) =>
    rows ? `<table style="border-collapse:collapse;font-size:13px;margin-bottom:18px"><tr>${head(cols)}</tr>${rows}</table>` : `<p style="color:#777">${empty}</p>`;

  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
<p>Revisión del ${esc(at)} (${COUNTRIES.join(", ")}): <b>${scanned.cases.length}</b> listing(s) FBA con stock sin BUYABLE ·
<b>${ok}</b> arreglado(s) · <b>${failed}</b> rechazado(s)/sin cambio · <b>${resolved.length}</b> resuelto(s) desde ayer · <b>${manual.length}</b> para Seller Central${scanned.ignored.length ? ` · ${scanned.ignored.length} silenciado(s) en fba_watch_ignore.txt` : ""}.</p>
<h3 style="font-size:15px;margin:18px 0 6px">Arreglos intentados</h3>
${table(["SKU", "País", "Acción", "Resultado", "Estado inmediato"], appliedRows, "Ninguno.")}
<h3 style="font-size:15px;margin:18px 0 6px">Necesitan a una persona (Seller Central)</h3>
${table(["SKU", "País", "Unidades", "Motivo"], manualRows, "Ninguno.")}
${pendingNext ? `<p style="color:#666">${pendingNext} caso(s) quedan para la siguiente ejecución por el tope de ${MAX_FIXES} arreglos/día.</p>` : ""}
${scanned.errors.length ? `<p style="color:#b00">Errores de la ejecución: ${scanned.errors.length} (ver informe en Supabase ${REPORT_KEY}).</p>` : ""}
<p style="color:#777;font-size:12px">Equipo de agentes de listings inactivos · backend/scripts/agents/inactive-listings.ts · informe completo en Supabase <code>${REPORT_KEY}</code> · runbook docs/runbooks/listings-inactivos.md</p>
</div>`;
}

async function sendEmail(subject: string, html: string): Promise<string> {
  if (!SEND_EMAIL) return "email desactivado (INACTIVE_AGENTS_EMAIL=0)";
  const user = process.env.GMAIL_USER?.trim();
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
  if (!user || !pass) return "sin GMAIL_USER/GMAIL_APP_PASSWORD: email no enviado";
  const transport = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } });
  const info = await transport.sendMail({ from: `Agentes listings <${user}>`, to: EMAIL_TO, subject, html });
  return `email enviado a ${EMAIL_TO} (${info.messageId})`;
}

// ───────────────────────────── Orquestador ─────────────────────────────

async function main() {
  const state = (await readJson<AgentState>(STATE_KEY)) ?? { attempts: {}, updatedAt: now.toISOString() };
  const scanned = await scan();

  // Casos cerrados: intentos de ayer que hoy ya no salen como inactivos con stock (y el país se escaneó bien).
  const currentKeys = new Set(scanned.cases.map(caseKey));
  const resolved: Array<{ key: string; action: FixAction }> = [];
  for (const [key, st] of Object.entries(state.attempts)) {
    const country = key.split("|")[1] ?? "";
    if (!scanned.scannedCountries.has(country)) continue;
    if (!currentKeys.has(key)) {
      resolved.push({ key, action: st.action });
      delete state.attempts[key];
    }
  }

  const attempts = Object.fromEntries(Object.entries(state.attempts).map(([key, st]) => [key, st.count]));
  const plan = planFixes(scanned.cases, { maxFixes: MAX_FIXES, attempts, maxAttempts: MAX_ATTEMPTS });
  const skippedByCap = Math.max(0, scanned.cases.length - plan.work.length - plan.manual.length);
  // Los amzn.gr.* y los que Amazon está revisando no son tarea de Seller Central.
  const manual = plan.manual.filter((p) => p.classification.action !== "ignore" && p.classification.action !== "wait");

  const applied: Array<{ item: InactiveCase; action: FixAction; outcome: Outcome; status: string[] }> = [];

  for (const planned of plan.work) {
    const { item, classification } = planned;
    if (!APPLY) {
      applied.push({ item, action: classification.action, outcome: { result: "validado (sin aplicar)", detail: "INACTIVE_AGENTS_APPLY!=1" }, status: [] });
      continue;
    }
    try {
      const outcome = await applyFix(item, classification.action);
      const status = outcome.result === "aplicado" ? await immediateStatus(item) : [];
      applied.push({ item, action: classification.action, outcome, status });
      // Se guarda el intento aunque el resultado sea "sin cambio": si no, se repetiría para siempre.
      const key = caseKey(item);
      const previous = state.attempts[key]?.count ?? 0;
      state.attempts[key] = {
        count: previous + 1,
        action: classification.action,
        lastAt: now.toISOString(),
        lastResult: outcome.result,
        units: item.units,
      };
    } catch (e) {
      applied.push({ item, action: classification.action, outcome: { result: "error", detail: String(e).slice(0, 300) }, status: [] });
      const key = caseKey(item);
      const previous = state.attempts[key]?.count ?? 0;
      state.attempts[key] = { count: previous + 1, action: classification.action, lastAt: now.toISOString(), lastResult: "error", units: item.units };
    }
  }

  // Los casos de hoy que no se han tocado (tope, escalados) también cuentan para el histórico de intentos,
  // salvo los que esperan a Amazon: esos no se reintentan ni se escalan.
  for (const planned of manual) {
    const key = caseKey(planned.item);
    if (!state.attempts[key]) {
      state.attempts[key] = {
        count: planned.attempts,
        action: planned.classification.action,
        lastAt: now.toISOString(),
        lastResult: "pendiente de persona",
        units: planned.item.units,
      };
    }
  }

  state.updatedAt = now.toISOString();
  if (APPLY) await writeJson(STATE_KEY, state);

  const okCount = applied.filter((a) => a.outcome.result === "aplicado").length;
  const validatedCount = applied.filter((a) => a.outcome.result.startsWith("validado") || a.outcome.result === "preview ok").length;
  const unchangedCount = applied.filter((a) => a.outcome.result === "sin cambio" || a.outcome.result === "sin datos").length;
  const rejectedCount = applied.length - okCount - validatedCount - unchangedCount;
  const subject = APPLY
    ? `FBA: ${scanned.cases.length} inactivos con stock · ${okCount} arreglados · ${manual.length} para Seller Central (${COUNTRIES.join(", ")})`
    : `FBA: ${scanned.cases.length} inactivos con stock · ${validatedCount} validados en simulación · ${manual.length} para Seller Central (${COUNTRIES.join(", ")})`;
  const html = reportHtml({ at: now.toISOString().slice(0, 10), scanned, applied, manual, resolved, pendingNext: Math.max(0, skippedByCap) });
  let email = "sin incidencias: email no enviado";
  if (scanned.cases.length || applied.length || resolved.length) {
    try {
      email = await sendEmail(subject, html);
    } catch (e) {
      email = `error al enviar el email: ${String(e).slice(0, 300)}`;
    }
  }

  const report = {
    at: now.toISOString(),
    apply: APPLY,
    paises: COUNTRIES,
    con_stock: scanned.conStock,
    inactivos: scanned.cases.length,
    resumen: {
      arreglados: okCount,
      validados: validatedCount,
      rechazados: rejectedCount,
      sin_cambio: unchangedCount,
      resueltos_desde_ayer: resolved.length,
      para_seller_central: manual.length,
      pendientes_siguiente_ejecucion: Math.max(0, skippedByCap),
    },
    aplicados: applied.map((a) => ({
      sku: a.item.sku,
      pais: a.item.country,
      accion: a.action,
      resultado: a.outcome.result,
      detalle: a.outcome.detail ?? null,
      estado_inmediato: a.status,
    })),
    seller_central: manual.map((p) => ({
      sku: p.item.sku,
      pais: p.item.country,
      unidades: p.item.units,
      motivo: p.classification.reason,
      codigos: p.classification.codes,
      intentos: p.attempts,
    })),
    ignorados: scanned.ignored,
    resueltos: resolved,
    errores: scanned.errors,
    email,
  };
  await writeJson(APPLY ? REPORT_KEY : `${REPORT_KEY}:simulation`, report);

  // Compatibilidad: el formato que ya leen el runbook y el proyecto.
  if (APPLY) await writeJson(WATCH_KEY, {
    at: report.at,
    paises: COUNTRIES,
    con_stock: scanned.conStock,
    inactivos: scanned.cases.length,
    ignorados: scanned.ignored,
    email,
    errores: scanned.errors,
    items: scanned.cases.map((c) => ({
      sku: c.sku,
      pais: c.country,
      asin: c.asin,
      unidades: c.units,
      estado: c.status,
      motivos: c.issues.filter((i) => i.severity === "ERROR").map((i) => `${i.code}: ${i.message}`),
    })),
  });

  console.log(
    `Agentes listings inactivos ${APPLY ? "APPLY" : "SIMULACIÓN"} | con stock ${JSON.stringify(scanned.conStock)} | inactivos ${scanned.cases.length} | ignorados ${scanned.ignored.length} | arreglados ${okCount} | validados ${validatedCount} | sin cambio ${unchangedCount} | rechazados ${rejectedCount} | Seller Central ${manual.length} | resueltos ${resolved.length} | errores ${scanned.errors.length} | ${email}`,
  );
  for (const a of applied) console.log("  FIX", a.item.sku, a.item.country, a.action, "→", a.outcome.result, a.outcome.detail ?? "");
  for (const m of manual) console.log("  MANUAL", m.item.sku, m.item.country, "→", m.classification.reason);
  for (const e of scanned.errors) console.log("  ERROR", JSON.stringify(e));

  if (scanned.errors.length && !scanned.cases.length && !Object.keys(scanned.conStock).length) process.exit(1);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
