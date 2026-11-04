/**
 * VERIFICADOR (solo lectura) de la regla de la plantilla de envío de Alemania:
 * toda oferta FBM (`fulfillment-channel` DEFAULT) de DE con precio efectivo < 35 € tiene que estar en la
 * plantilla **de pago**: `legacy-template-id` (o el atributo ausente, que Amazon cobra igual a 3,99 €).
 * La plantilla del UUID `395e11ea-3c51-4820-aa8f-74e6cf2a4e72` es la de **envío gratis** y por debajo de
 * 35 € es una violación.
 *
 * Evidencia de qué cobra qué (Product Pricing API, `GET /products/pricing/v0/listings/{sku}/offers`):
 * 12 de 12 SKU en el UUID → `Shipping: 0.00`; 12 de 12 SKU en GRUPO 0 / `legacy-template-id` →
 * `Shipping: 3.99`. Y en pedidos reales, el UUID nunca cobró 3,99 € y la plantilla de pago siempre.
 *
 * Es el contrapunto independiente de `fix-de-shipping-group.ts`: no comparte su parser ni su decisión,
 * y no escribe nada en Amazon (solo GET). Sirve para demostrar "0 violaciones" después de la corrección.
 *
 * Qué se comprueba (por defecto):
 *   - TODOS los FBM que el informe pone en la plantilla equivocada y están a menos de `NEAR` € por encima
 *     del umbral (por defecto 12 € → hasta 47 €). Con el destino `legacy-template-id`, eso son todos los
 *     del UUID por debajo de 47 €: los candidatos de la regla y los que una oferta no registrada pueda
 *     bajar de 35 € (35 / 0,75 ≈ 46,7 para un descuento del 25 %).
 *   - Una muestra aleatoria (VERIFY_SAMPLE, por defecto 100) del resto.
 *   - VERIFY_SAMPLE=0 → todos los FBM del informe (lento: ~5 lecturas/s).
 * El veredicto NO se fía del informe: vuelve a leer cada listing en vivo y usa el precio efectivo de
 * Amazon (oferta vigente si la hay, si no el precio de venta).
 *
 * Env:
 *   VERIFY_SAMPLE=n          → tamaño de la muestra del resto (0 = todos). Por defecto 100.
 *   VERIFY_CONCURRENCY=n     → lecturas en paralelo. Por defecto 4.
 *   VERIFY_PRICE_LIMIT=35    → umbral en euros. Por defecto 35.
 *   VERIFY_TARGET_GROUP=…    → plantilla que debe llevar lo barato. Por defecto `legacy-template-id`.
 *   VERIFY_NEAR=12           → margen por encima del umbral que se comprueba siempre. Por defecto 12.
 *   VERIFY_NEAR_CAP=n        → tope (muestra aleatoria) del bloque anterior; 0 = sin tope. Por defecto 0.
 *   VERIFY_DE_REPORT_TSV=…   → usa un TSV de GET_MERCHANT_LISTINGS_ALL_DATA en vez de pedirlo a Amazon.
 *   VERIFY_CSV=…             → CSV de violaciones (por defecto ../de_shipping_group_verify.csv).
 *   VERIFY_IGNORE_ERRORS=1   → no falla (código 1) por listings ilegibles.
 *
 * Modo ENVÍO DEL COMPRADOR (`SHIPPING_CHECK=n` o `--shipping=n`): en vez de mirar el atributo, mira lo que
 * Amazon cobra de verdad (`Offers[].Shipping` de la oferta propia FBM). Es la comprobación del día siguiente:
 * el atributo puede estar bien y el envío seguir a 0,00 € porque Amazon recalcula el offer con retraso
 * (en el lote del 26/10 tardó hasta un par de días).
 *   SHIPPING_CHECK_SOURCE_CSV=… → de dónde salen los SKU (por defecto ../de_shipping_group_aplicados.csv).
 *   SHIPPING_CHECK_PAUSE_MS=…   → pausa entre SKUs (por defecto 1000 ms; el endpoint va a ~0,5 req/s).
 *   SHIPPING_CHECK_MAX_TRIES=…  → lecturas máximas para juzgar `n` (por defecto 5n: muchos parcheados están
 *     Inactive y devuelven `NoBuyableOffers`, sin oferta que juzgar).
 *   SHIPPING_CHECK_RETRIES=…    → reintentos propios ante 429/5xx (por defecto 3, backoff 2/4/8 s).
 *   SHIPPING_CHECK_CSV_OUT=…    → CSV del resultado (por defecto ../de_shipping_group_shipping_check.csv).
 * En este modo la salida es 1 solo si algún SKU sigue a 0,00 € (o si no se pudo juzgar ninguno).
 * Código de salida: 0 si no hay violaciones, 1 si hay alguna (o si hay lecturas fallidas). Una plantilla
 * distinta de las dos (ni pago ni envío gratis) no es violación de la regla: se lista como `otra` para
 * revisarla a mano y no cambia el código de salida.
 * Uso: npm run verify:de-shipping-group [-- --sample=200]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../src/config/env";
import { readOfferPrices } from "../src/lib/priceBounds";
import { SpApiClient } from "../src/spapi/client";
import { getListingsItem } from "../src/spapi/endpoints/listingsItems";
import { getListingOffers } from "../src/spapi/endpoints/productPricing";
import { createReport, downloadReportDocument, getReport, getReportDocument } from "../src/spapi/endpoints/reports";
import { sleep } from "../src/spapi/rateLimiter";
import {
  buyerShipping,
  parseAppliedSkusCsv,
  pickSample,
  summarizeBuyerShipping,
  type BuyerShippingVerdict,
} from "./lib/de-buyer-shipping";
import { pool } from "./lib/listing-cleanup-api";


const DE_MARKETPLACE_ID = "A1PA6795UKMFR9";
const SHIPPING_GROUP_ATTR = "merchant_shipping_group";
const FBM_CHANNEL = "DEFAULT";
/** Plantilla de envío GRATIS del vendedor: por debajo de 35 € no puede quedarse ahí. */
const FREE_SHIPPING_GROUP = "395e11ea-3c51-4820-aa8f-74e6cf2a4e72";
/** Plantilla de pago (3,99 €): la que debe llevar todo lo barato. */
const PAID_SHIPPING_GROUP = "legacy-template-id";

/** `--sample=200` gana sobre VERIFY_SAMPLE. */
function argNumber(name: string): number | null {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  const raw = hit?.split("=")[1];
  const n = Number(raw);
  return raw != null && Number.isFinite(n) && n >= 0 ? n : null;
}

const PRICE_LIMIT = argNumber("limit") ?? (Number(process.env.VERIFY_PRICE_LIMIT) || 35);
const SAMPLE = argNumber("sample") ?? (process.env.VERIFY_SAMPLE != null ? Number(process.env.VERIFY_SAMPLE) : 100);
const CONCURRENCY = Math.max(1, Number(process.env.VERIFY_CONCURRENCY) || 4);
const TARGET_GROUP = (process.env.VERIFY_TARGET_GROUP ?? PAID_SHIPPING_GROUP).trim();
/**
 * Margen por encima del umbral en el que se comprueban TODOS los listings que están en la plantilla
 * equivocada (VERIFY_NEAR, por defecto 12 €). Con 35 € y un descuento del 25 % hace falta llegar a
 * 46,67 € para que una oferta baje de 35 € sin que se vea en el precio de tarifa.
 */
const NEAR = argNumber("near") ?? (process.env.VERIFY_NEAR != null ? Number(process.env.VERIFY_NEAR) : 12);
/**
 * Tope para el bloque "siempre" (VERIFY_NEAR_CAP, 0 = sin tope). Con 4.865 candidatos la pasada completa
 * tarda horas a las ~5 lecturas/s de Amazon; con un tope se obtiene una línea base representativa.
 */
const NEAR_CAP = argNumber("near-cap") ?? (Number(process.env.VERIFY_NEAR_CAP) || 0);
const IGNORE_ERRORS = process.env.VERIFY_IGNORE_ERRORS === "1";
/** backend/scripts → backend → raíz del repo: el `blocked_skus.txt` no depende del cwd. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(HERE, "..", "..");
const REPORT_TSV = process.env.VERIFY_DE_REPORT_TSV;
const CSV = process.env.VERIFY_CSV ?? path.join(root, "de_shipping_group_verify.csv");
const BLOCKED = path.join(root, "blocked_skus.txt");

/**
 * Modo comprobación del envío real. Prioridad: `--shipping=n` > `SHIPPING_CHECK=n` > `--shipping` (10).
 * Sin ninguno de los tres, el verificador hace lo de siempre (atributo de plantilla).
 */
const SHIPPING_CHECK: number | null = (() => {
  const flag = process.argv.slice(2).find((a) => a === "--shipping" || a.startsWith("--shipping="));
  const raw = flag?.includes("=") ? flag.split("=")[1] : undefined;
  const fromFlag = Number(raw);
  if (raw != null && Number.isFinite(fromFlag) && fromFlag > 0) return Math.floor(fromFlag);
  const fromEnv = Number(process.env.SHIPPING_CHECK);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return flag ? 10 : null;
})();
const SHIPPING_SOURCE_CSV = process.env.SHIPPING_CHECK_SOURCE_CSV ?? path.join(root, "de_shipping_group_aplicados.csv");
const SHIPPING_CSV_OUT = process.env.SHIPPING_CHECK_CSV_OUT ?? path.join(root, "de_shipping_group_shipping_check.csv");
/** Número de entorno con caída al valor por defecto si viene vacío o no es un número ≥ 0. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const SHIPPING_PAUSE_MS = envNumber("SHIPPING_CHECK_PAUSE_MS", 1000);
const SHIPPING_RETRIES = envNumber("SHIPPING_CHECK_RETRIES", 3);

/** El informe llama `GRUPO 4` (o el UUID) a la plantilla de envío gratis. */
const reportIsFree = (g: string) => /^grupo\s*4$/i.test(g.trim()) || g.trim() === FREE_SHIPPING_GROUP;

const client = new SpApiClient({ credentials: env.spApi });

interface ReportRow {
  sku: string;
  asin: string;
  price: number | null;
  channel: string;
  group: string;
  status: string;
}

/** Importe del informe ("42,5" / " 42.5 " / "1.234,56") → número o null. */
function parseAmount(raw: unknown): number | null {
  const text = String(raw ?? "").replace(/[^\d.,]/g, "").trim();
  if (!text) return null;
  const normalized = text.includes(",") && text.includes(".")
    ? (text.lastIndexOf(",") > text.lastIndexOf(".") ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, ""))
    : text.replace(",", ".");
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** TSV del informe maestro de DE (cabecera + una fila por SKU). */
function parseReport(text: string): ReportRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const header = lines[0].split("\t").map((h) => h.trim().replace(/^\uFEFF/, ""));
  const idx = (name: string) => header.indexOf(name);
  const col = { sku: idx("seller-sku"), asin: idx("asin1"), price: idx("price"), channel: idx("fulfillment-channel"), group: idx("merchant-shipping-group"), status: idx("status") };
  if (col.sku < 0 || col.price < 0 || col.channel < 0) throw new Error("El informe de DE no trae seller-sku/price/fulfillment-channel");
  const out: ReportRow[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split("\t");
    const sku = (c[col.sku] ?? "").trim();
    if (!sku) continue;
    out.push({
      sku,
      asin: col.asin >= 0 ? (c[col.asin] ?? "").trim() : "",
      price: parseAmount(c[col.price]),
      channel: (c[col.channel] ?? "").trim(),
      group: col.group >= 0 ? (c[col.group] ?? "").trim() : "",
      status: col.status >= 0 ? (c[col.status] ?? "").trim() : "",
    });
  }
  return out;
}

/** Pide el informe maestro de DE en vivo y espera a que esté listo (Reports API, solo lectura). */
async function fetchLiveReport(): Promise<string> {
  const { reportId } = await createReport(client, { reportType: "GET_MERCHANT_LISTINGS_ALL_DATA", marketplaceIds: [DE_MARKETPLACE_ID] });
  console.log(`Informe de DE solicitado (${reportId}); esperando a que Amazon lo genere…`);
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    await sleep(10_000);
    const status = await getReport(client, reportId);
    if (status.processingStatus === "DONE" && status.reportDocumentId) {
      const doc = await getReportDocument(client, status.reportDocumentId);
      return (await downloadReportDocument(doc)).toString("utf-8");
    }
    if (status.processingStatus === "CANCELLED" || status.processingStatus === "FATAL") {
      throw new Error(`Amazon canceló el informe (${status.processingStatus})`);
    }
  }
  throw new Error("Timeout esperando el informe de DE (30 min)");
}

/** SKU retirados (blocked_skus.txt): no se tocan, así que no cuentan como violación. */
function blockedSkus(): Set<string> {
  if (!fs.existsSync(BLOCKED)) return new Set();
  return new Set(
    fs.readFileSync(BLOCKED, "utf-8").split(/\r?\n/).map((l) => l.trim().toUpperCase()).filter((l) => l && !l.startsWith("#")),
  );
}

/** Plantilla de envío de DE del listing en vivo (UUID, `legacy-template-id`, o null si no tiene). */
function liveGroup(listing: unknown): string | null {
  const attr = (listing as { attributes?: Record<string, unknown> } | null)?.attributes?.[SHIPPING_GROUP_ATTR];
  const entries = (Array.isArray(attr) ? attr : []) as Array<{ value?: unknown; marketplace_id?: unknown }>;
  const hit = entries.find((e) => e?.marketplace_id === DE_MARKETPLACE_ID && e.value != null) ?? entries.find((e) => e?.value != null);
  return hit?.value != null ? String(hit.value) : null;
}

/** Canal del listing en vivo: FBM si tiene alguna oferta DEFAULT (un SKU puede tener FBA y FBM a la vez). */
function liveChannel(listing: unknown): string | null {
  const availability = (listing as { attributes?: Record<string, unknown> } | null)?.attributes?.fulfillment_availability;
  const codes = (Array.isArray(availability) ? availability : [])
    .map((e) => (e as { fulfillment_channel_code?: unknown })?.fulfillment_channel_code)
    .filter((c): c is string => typeof c === "string" && c !== "");
  // Un SKU híbrido (AMAZON_EU + DEFAULT) tiene oferta FBM: la plantilla de envío le afecta igual.
  return codes.includes(FBM_CHANNEL) ? FBM_CHANNEL : codes[0] ?? null;
}

/** Oferta de consumidor (audience ALL) de DE dentro de purchasable_offer. */
function deOffer(listing: unknown): Record<string, unknown> | undefined {
  const offers = (listing as { attributes?: Record<string, unknown> } | null)?.attributes?.purchasable_offer;
  const list = (Array.isArray(offers) ? offers : []) as Array<Record<string, unknown>>;
  return list.find((o) => (o.audience ?? "ALL") === "ALL" && (o.marketplace_id ?? DE_MARKETPLACE_ID) === DE_MARKETPLACE_ID);
}

/** Precio efectivo en vivo: el de la oferta si no ha caducado, si no el precio de venta. */
function liveEffectivePrice(listing: unknown): number | null {
  const offer = deOffer(listing);
  if (!offer) return null;
  const prices = readOfferPrices(offer);
  return prices.sale ?? prices.price;
}

interface Checked {
  sku: string;
  asin: string;
  reportGroup: string;
  reportPrice: number | null;
  liveGroup: string | null;
  channel: string | null;
  price: number | null;
  status: "ok" | "violacion" | "otra" | "ilegible" | "sin precio";
  detail: string;
}

interface ShippingRow {
  sku: string;
  price: number | null;
  shipping: number | null;
  verdict: BuyerShippingVerdict | "ilegible";
  detail: string;
}

const eur = (value: number | null) => (value == null ? "—" : `${value.toFixed(2).replace(".", ",")} €`);

/** GET de la oferta con reintentos propios ante 429/5xx, además de los del SpApiClient. */
async function listingOffersWithRetry(sku: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getListingOffers(client, { marketplaceId: DE_MARKETPLACE_ID, sku, itemCondition: "New" });
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      const retryable = status === 429 || (status != null && status >= 500);
      if (!retryable || attempt >= SHIPPING_RETRIES) throw e;
      const waitMs = 2000 * 2 ** attempt;
      console.warn(`  ${sku}: ${status} de Amazon → reintento ${attempt + 1}/${SHIPPING_RETRIES} en ${waitMs / 1000}s`);
      await sleep(waitMs);
    }
  }
}

/**
 * SKU que hay que comprobar: los ya parcheados (CSV acumulado de PATCH aceptados) y, si ese CSV no existe,
 * los FBM del informe que ya están en la plantilla de pago.
 */
async function shippingSourceSkus(): Promise<{ skus: string[]; origin: string }> {
  if (fs.existsSync(SHIPPING_SOURCE_CSV)) {
    return { skus: parseAppliedSkusCsv(fs.readFileSync(SHIPPING_SOURCE_CSV, "utf-8")), origin: SHIPPING_SOURCE_CSV };
  }
  console.warn(`No existe ${SHIPPING_SOURCE_CSV}: se usan los FBM del informe que ya están en la plantilla de pago.`);
  const text = REPORT_TSV ? fs.readFileSync(REPORT_TSV, "utf-8") : await fetchLiveReport();
  return {
    skus: parseReport(text).filter((r) => r.channel === FBM_CHANNEL && !reportIsFree(r.group)).map((r) => r.sku),
    origin: "informe de DE (FBM en plantilla de pago)",
  };
}

/**
 * Comprueba el envío REAL que ve el comprador en `n` SKU ya parcheados. Solo GET, secuencial y con pausa:
 * el endpoint va a ~0,5 req/s. El atributo puede estar bien y el envío seguir a 0,00 € porque Amazon
 * recalcula la oferta con retraso (hasta un par de días en el lote del 26/10).
 */
async function checkBuyerShipping(n: number) {
  const { skus, origin } = await shippingSourceSkus();
  // Se siguen leyendo SKU hasta juzgar `n` (muchos de los parcheados están Inactive: sin oferta comprable).
  const maxTries = Math.max(n, Number(process.env.SHIPPING_CHECK_MAX_TRIES) || n * 5);
  const targets = pickSample(skus, maxTries);
  console.log(`Envío real del comprador (Product Pricing API getListingOffers) · fuente: ${origin} (${skus.length} SKU)`);
  console.log(`Objetivo: ${n} SKU juzgados (máximo ${targets.length} lecturas) · pausa ${SHIPPING_PAUSE_MS} ms · reintentos propios ${SHIPPING_RETRIES}`);

  const rows: ShippingRow[] = [];
  let judged = 0;
  for (const [i, sku] of targets.entries()) {
    if (judged >= n) break;
    try {
      const raw = await listingOffersWithRetry(sku);
      const v = buyerShipping(raw.payload, env.sellerId);
      rows.push({ sku, price: v.price, shipping: v.shipping, verdict: v.verdict, detail: v.detail });
      if (v.verdict === "cobrando" || v.verdict === "aun-cero" || v.verdict === "sin-dato") judged++;
      const label = v.verdict === "cobrando" ? "✔ cobrando" : v.verdict === "aun-cero" ? "✗ aún 0,00" : v.verdict;
      console.log(`  ${sku}  precio ${eur(v.price)} · envío ${eur(v.shipping)} · ${label} (${v.detail})`);
    } catch (e) {
      const message = String(e);
      // Un SKU que ya no existe en DE (InvalidInput/NOT_FOUND) no es un fallo de lectura: se salta igual que
      // un `NoBuyableOffers` y no consume lecturas del objetivo.
      const gone = /invalid sku|not_found|not found/i.test(message);
      rows.push({
        sku,
        price: null,
        shipping: null,
        verdict: gone ? "sin-oferta" : "ilegible",
        detail: gone ? `SKU inexistente en DE (Amazon: ${message.slice(0, 90)})` : message.slice(0, 140),
      });
      console.log(`  ${sku}  ${gone ? "· sin oferta" : "ILEGIBLE"}: ${message.slice(0, 140)}`);
    }
    if (i < targets.length - 1 && SHIPPING_PAUSE_MS > 0) await sleep(SHIPPING_PAUSE_MS);
  }

  const summary = summarizeBuyerShipping(
    rows.map((r) => ({ verdict: (r.verdict === "ilegible" ? "sin-dato" : r.verdict) as BuyerShippingVerdict })),
  );
  const charged = rows.filter((r) => r.verdict === "cobrando");
  const stillZero = rows.filter((r) => r.verdict === "aun-cero");
  const noData = rows.filter((r) => r.verdict === "ilegible" || r.verdict === "sin-dato");
  const notJudgeable = rows.filter((r) => r.verdict === "sin-oferta" || r.verdict === "solo-fba");

  const cell = (v: unknown) => {
    const text = String(v ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  fs.writeFileSync(SHIPPING_CSV_OUT, [
    ["at", "sku", "precio", "shipping", "veredicto", "detalle"].join(","),
    ...rows.map((r) => [new Date().toISOString(), r.sku, r.price ?? "", r.shipping ?? "", r.verdict, r.detail].map(cell).join(",")),
  ].join("\n"), "utf-8");

  const judgedTotal = charged.length + stillZero.length + noData.length;
  console.log(`\nResumen: ${summary.charging}/${judgedTotal} ya cobran, ${summary.stillZero} siguen a 0,00${noData.length ? ` (${noData.length} sin dato)` : ""}${notJudgeable.length ? `, ${notJudgeable.length} sin oferta comprable (inactivos, se saltan)` : ""}`);
  if (stillZero.length) {
    const muestra = stillZero.slice(0, 10).map((r) => `${r.sku} (${eur(r.price)})`).join(", ");
    console.error(`  Aún 0,00: ${muestra}${stillZero.length > 10 ? " …" : ""}`);
  }
  if (charged.length) console.log(`  Ya cobran: ${charged.slice(0, 10).map((r) => `${r.sku} ${eur(r.shipping)}`).join(", ")}${charged.length > 10 ? " …" : ""}`);
  console.log(`Detalle en ${SHIPPING_CSV_OUT}`);

  if (summary.exitCode === 1) {
    if (summary.stillZero > 0) console.error(`\n❌ ${summary.stillZero} de ${judgedTotal} SKU siguen con envío 0,00 €: Amazon todavía no ha recalculado (o la plantilla no es la correcta).`);
    else console.error(`\n❌ Ninguno de los ${rows.length} SKU leídos se pudo juzgar: la comprobación no es concluyente (reintentar o mirar los inactivos).`);
    process.exit(1);
  }
  console.log(`\n✅ ${summary.charging}/${judgedTotal} SKU ya cobran envío en la oferta del comprador.`);
}

async function main() {
  if (SHIPPING_CHECK != null) return checkBuyerShipping(SHIPPING_CHECK);
  const blocked = blockedSkus();
  const text = REPORT_TSV ? fs.readFileSync(REPORT_TSV, "utf-8") : await fetchLiveReport();
  const rows = parseReport(text);
  const fbm = rows.filter((r) => r.channel === FBM_CHANNEL);
  console.log(`Informe DE: ${rows.length} filas | FBM: ${fbm.length} | FBA: ${rows.length - fbm.length} | umbral ${PRICE_LIMIT} € | objetivo ${TARGET_GROUP}`);

  // Selección: todos los que están en la plantilla equivocada y a menos de NEAR € por encima del umbral
  // (son los únicos que pueden violar la regla) + muestra aleatoria del resto.
  // El informe solo distingue "GRUPO 4" (la plantilla gratis) de "GRUPO 0" (atributo ausente o legacy).
  const targetIsFree = TARGET_GROUP === FREE_SHIPPING_GROUP;
  const wrongSide = (g: string) => (targetIsFree ? !reportIsFree(g) : reportIsFree(g));
  const nearAll = fbm.filter((r) => wrongSide(r.group) && r.price != null && r.price < PRICE_LIMIT + NEAR);
  const shuffledNear = [...nearAll];
  for (let i = shuffledNear.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledNear[i], shuffledNear[j]] = [shuffledNear[j], shuffledNear[i]];
  }
  const near = NEAR_CAP > 0 ? shuffledNear.slice(0, NEAR_CAP) : shuffledNear;
  const nearSkus = new Set(near.map((r) => r.sku));
  const rest = fbm.filter((r) => !nearSkus.has(r.sku));
  const shuffled = [...rest];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const sample = SAMPLE === 0 ? shuffled : shuffled.slice(0, SAMPLE);
  const target = [...near, ...sample];
  const capped = NEAR_CAP > 0 && nearAll.length > NEAR_CAP ? ` (muestra de ${nearAll.length})` : "";
  console.log(`A comprobar: ${target.length} (${near.length}${capped} en la plantilla equivocada y <${PRICE_LIMIT + NEAR} € + ${sample.length} de muestra de ${rest.length})`);

  const checked: Checked[] = [];
  let done = 0;
  await pool(target, CONCURRENCY, async (row) => {
    let listing: any;
    let status: Checked["status"] = "ok";
    let detail = "";
    let group: string | null = null;
    let channel: string | null = null;
    let price: number | null = null;
    try {
      listing = await getListingsItem(client, {
        sellerId: env.sellerId,
        sku: row.sku,
        marketplaceIds: [DE_MARKETPLACE_ID],
        includedData: ["attributes", "summaries"],
      });
      group = liveGroup(listing);
      channel = liveChannel(listing) ?? row.channel;
      price = liveEffectivePrice(listing);
    } catch (e) {
      status = "ilegible";
      detail = String(e).slice(0, 120);
    }
    if (status === "ok") {
      if (channel !== FBM_CHANNEL) {
        status = "ok";
        detail = `ya no es FBM (${channel ?? "?"})`;
      } else if (blocked.has(row.sku.toUpperCase())) {
        status = "ok";
        detail = "SKU retirado (blocked_skus.txt): no se toca";
      } else if (price == null) {
        status = "sin precio";
        detail = "sin precio en vivo: no se puede juzgar";
      } else if (group !== TARGET_GROUP) {
        // Criterio: FBM + precio efectivo < umbral + plantilla = la de envío gratis. El atributo ausente y
        // `legacy-template-id` cobran 3,99 € y NO son violación. Una plantilla distinta de las dos no se
        // puede juzgar por API, así que se marca aparte (`otra`) para revisarla a mano, no como violación.
        if (group == null) {
          detail = "atributo ausente (3,99 €): ya cobra envío";
        } else if (price < PRICE_LIMIT && group === FREE_SHIPPING_GROUP) {
          status = "violacion";
          detail = `${price.toFixed(2)} € y la plantilla GRATIS (${FREE_SHIPPING_GROUP})`;
        } else if (price < PRICE_LIMIT) {
          status = "otra";
          detail = `${price.toFixed(2)} € y una plantilla que no es la de pago (${group}): revisar a mano`;
        }
      }
    }
    checked.push({ sku: row.sku, asin: row.asin, reportGroup: row.group, reportPrice: row.price, liveGroup: group, channel, price, status, detail });
    if (++done % 50 === 0) console.log(`  … ${done}/${target.length}`);
  });

  const by = (s: Checked["status"]) => checked.filter((c) => c.status === s);
  const violations = by("violacion").sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
  const others = by("otra").sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
  const unreadable = by("ilegible");
  const noPrice = by("sin precio");

  // Distribución de plantillas en vivo y coherencia con la etiqueta del informe.
  const liveGroups: Record<string, number> = {};
  for (const c of checked) {
    if (c.channel !== FBM_CHANNEL) continue;
    const key = c.liveGroup ?? "ausente (3,99 €)";
    liveGroups[key] = (liveGroups[key] ?? 0) + 1;
  }
  const reportFree = checked.filter((c) => c.channel === FBM_CHANNEL && /^grupo\s*4$/i.test(c.reportGroup));
  const mismatches = reportFree.filter((c) => c.liveGroup !== FREE_SHIPPING_GROUP);

  console.log(`\nComprobados: ${checked.length} | violaciones: ${violations.length} | otras plantillas: ${others.length} | sin precio: ${noPrice.length} | ilegibles: ${unreadable.length}`);
  console.log(`Plantillas en vivo (FBM): ${JSON.stringify(liveGroups)}`);
  console.log(`El informe dice "GRUPO 4" y el vivo NO es la plantilla gratis: ${mismatches.length} de ${reportFree.length}`);
  for (const c of violations.slice(0, 40)) console.log(`  VIOLACIÓN ${c.sku} (${c.asin}) ${c.detail} [informe: ${c.reportGroup} ${c.reportPrice ?? "—"} €]`);
  for (const c of others.slice(0, 20)) console.log(`  REVISAR ${c.sku} (${c.asin}) ${c.detail}`);
  for (const c of unreadable.slice(0, 10)) console.log(`  ILEGIBLE ${c.sku}: ${c.detail}`);

  const cell = (v: unknown) => {
    const text = String(v ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  fs.writeFileSync(CSV, [
    ["sku", "asin", "precio_efectivo_vivo", "plantilla_viva", "grupo_informe", "precio_informe", "veredicto", "detalle"].join(","),
    ...checked.map((c) =>
      [c.sku, c.asin, c.price ?? "", c.liveGroup ?? "ausente", c.reportGroup, c.reportPrice ?? "", c.status, c.detail].map(cell).join(","),
    ),
  ].join("\n"), "utf-8");
  console.log(`Detalle en ${CSV}`);

  if (violations.length > 0) { console.error(`\n❌ ${violations.length} FBM con precio efectivo < ${PRICE_LIMIT} € en la plantilla de envío gratis.`); process.exit(1); }
  if (unreadable.length > 0 && !IGNORE_ERRORS) { console.error(`\n❌ ${unreadable.length} listings ilegibles: la verificación no es concluyente (VERIFY_IGNORE_ERRORS=1 para ignorarlos).`); process.exit(1); }
  if (others.length > 0) console.warn(`\n⚠️  ${others.length} FBM < ${PRICE_LIMIT} € en una plantilla que no es ni la de pago ni la de envío gratis (ver ${CSV}): no son violación de la regla, pero el corrector no las toca y hay que mirarlas.`);
  console.log(`\n✅ 0 violaciones en ${checked.length} listings comprobados.`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
