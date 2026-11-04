/**
 * Plantilla de envío de Alemania (ver docs/runbooks/envio-de-grupo4.md): toda oferta FBM
 * (`fulfillment-channel` DEFAULT) con precio efectivo < 35 € tiene que estar en la plantilla de PAGO
 * (`legacy-template-id`, 3,99 €), no en la de ENVÍO GRATIS
 * (`395e11ea-3c51-4820-aa8f-74e6cf2a4e72`, la que el informe llama "GRUPO 4", 0,00 €).
 *
 * Dos fases:
 *   - AUDITORÍA (por defecto): no escribe en Amazon. Lee el informe maestro de DE (Reports API) o el TSV
 *     que se le pase, cruza los overrides de precio del repo (rules:sales, fixed_prices.csv, precios
 *     manuales del panel), escribe de_shipping_group_audit.csv y publica el resumen en Supabase
 *     (rules:de-shipping-group:last-run).
 *   - APLICACIÓN (SHIPPING_GROUP_APPLY=1): antes de cada PATCH vuelve a leer el listing en vivo y solo
 *     parchea si el atributo sigue siendo la plantilla de envío gratis, el canal en vivo es FBM y el
 *     precio efectivo en vivo sigue < 35 €. Reanudable con backend/data/de-shipping-group-state.json,
 *     con tope por ejecución y los rechazos en de_shipping_group_errores.csv.
 *
 * Env:
 *   SHIPPING_GROUP_APPLY=1     → envía los PATCH a Amazon; si no, solo audita.
 *   DE_REPORT_TSV              → usa este TSV (GET_MERCHANT_LISTINGS_ALL_DATA de DE) en vez de pedirlo a Amazon.
 *   SHIPPING_GROUP_LIMIT       → máximo de SKU a parchear por ejecución (por defecto 5000).
 *   SHIPPING_GROUP_CONFIRM=1   → obligatorio si el tope pasa de CONFIRM_FROM_LIMIT (protección del lote grande).
 *   SHIPPING_GROUP_STATE_TTL_DAYS → días que un `ok` del estado evita reintentar (por defecto 30; 0 = nunca caduca).
 *   SHIPPING_GROUP_AUDIT_CSV   → salida de la auditoría (por defecto ../de_shipping_group_audit.csv).
 *   SHIPPING_GROUP_ERRORS_CSV  → salida de rechazos (por defecto ../de_shipping_group_errores.csv).
 *   SHIPPING_GROUP_APPLIED_CSV → registro acumulado de los PATCH aceptados (../de_shipping_group_aplicados.csv).
 *   FIXED_PRICES_CSV           → fixed_prices.csv (por defecto ../fixed_prices.csv).
 *   BLOCKED_SKUS_FILE          → blocked_skus.txt (por defecto ../blocked_skus.txt).
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY → overrides (rules:sales, precios manuales) e informe.
 *
 * Las rutas por defecto se resuelven desde la ubicación del script, no desde el cwd: ejecutarlo desde la
 * raíz con `tsx backend/scripts/...` no puede dejar el filtro de blocked_skus.txt ni fixed_prices.csv sin
 * leer (fail-open justo en los inputs que evitan mover lo que no toca).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../src/config/env";
import { loadManualPrices } from "../src/lib/manualPrices";
import { parseFixedPrices } from "../src/lib/priceBounds";
import { SpApiClient } from "../src/spapi/client";
import { getListingsItem, patchListingsItem } from "../src/spapi/endpoints/listingsItems";
import { createReport, downloadReportDocument, getReport, getReportDocument } from "../src/spapi/endpoints/reports";
import { sleep } from "../src/spapi/rateLimiter";
import {
  blockedSkusFromText,
  CONFIRM_FROM_LIMIT,
  DE_MARKETPLACE_ID,
  decideRow,
  FREE_SHIPPING_GROUP,
  isFreeShippingGroup,
  liveDecision,
  listingProductType,
  overrideKey,
  PAID_SHIPPING_GROUP,
  parseDeReportTsv,
  parseLimit,
  parseSalesSnapshot,
  PRICE_LIMIT,
  shippingGroupPatch,
  skuFamily,
  stateIsFresh,
  summarize,
  type DeReportRow,
  type PriceOverrides,
  type RowDecision,
} from "./lib/de-shipping-group";
import { writeSnapshot } from "./lib/listing-archive-store";
import { pool } from "./lib/listing-cleanup-api";

const APPLY = process.env.SHIPPING_GROUP_APPLY === "1";
/** backend/scripts → backend → raíz del repo. Independiente del cwd a propósito. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(HERE, "..");
const root = path.resolve(BACKEND_DIR, "..");
const REPORT_TSV = process.env.DE_REPORT_TSV;
const AUDIT_CSV = process.env.SHIPPING_GROUP_AUDIT_CSV ?? path.join(root, "de_shipping_group_audit.csv");
const ERRORS_CSV = process.env.SHIPPING_GROUP_ERRORS_CSV ?? path.join(root, "de_shipping_group_errores.csv");
const APPLIED_CSV = process.env.SHIPPING_GROUP_APPLIED_CSV ?? path.join(root, "de_shipping_group_aplicados.csv");
const FIXED_CSV = process.env.FIXED_PRICES_CSV ?? path.join(root, "fixed_prices.csv");
const BLOCKED_FILE = process.env.BLOCKED_SKUS_FILE ?? path.join(root, "blocked_skus.txt");
const LIMIT = parseLimit(process.env.SHIPPING_GROUP_LIMIT);
const CONFIRM = process.env.SHIPPING_GROUP_CONFIRM === "1";
const TTL_RAW = Number(process.env.SHIPPING_GROUP_STATE_TTL_DAYS ?? 30);
const STATE_TTL_DAYS = Number.isFinite(TTL_RAW) && TTL_RAW >= 0 ? TTL_RAW : 30;
const STATE_FILE = path.join(BACKEND_DIR, "data", "de-shipping-group-state.json");
const AUDIT_KEY = "rules:de-shipping-group:last-run";
const APPLY_KEY = "rules:de-shipping-group:last-apply";

const REPORT_TYPE = "GET_MERCHANT_LISTINGS_ALL_DATA";
const POLL_MS = 5000;
const MAX_POLLS = 60;
const CONCURRENCY = 4;
const PROGRESS_EVERY = 200;

const client = new SpApiClient({ credentials: env.spApi });
const isNotFound = (e: unknown) => /NOT_FOUND|not found|404/i.test(String(e));

const supabaseUrl = (() => {
  const raw = (process.env.SUPABASE_URL ?? "").trim();
  return (raw && /^https?:\/\//.test(raw) ? raw : raw ? `https://${raw}` : "").replace(/\/+$/, "");
})();
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

const headers = () => ({ apikey: supabaseKey!, Authorization: `Bearer ${supabaseKey}` });

/** rules:sales de Supabase (ofertas registradas con set_sale_price.py). Sin Supabase, ninguna. */
async function loadSales(): Promise<Map<string, { price: number; start: string; end: string }>> {
  if (!supabaseUrl || !supabaseKey) return new Map();
  const res = await fetch(`${supabaseUrl}/rest/v1/snapshots?key=eq.${encodeURIComponent("rules:sales")}&select=data`, { headers: headers() });
  if (!res.ok) throw new Error(`Supabase rules:sales ${res.status}: ${await res.text()}`);
  return parseSalesSnapshot(((await res.json()) as Array<{ data: unknown }>)[0]?.data ?? null);
}

/** Un input obligatorio que falta casi siempre es un cwd equivocado: mejor abortar que decidir sin él. */
function requireFile(file: string, what: string): void {
  if (!fs.existsSync(file)) {
    throw new Error(`No encuentro ${what}: ${file}. Ejecuta desde backend/ (npm run …) o pásalo por variable de entorno.`);
  }
}

/** Overrides de precio del repo, con la prioridad que documenta price_overrides.py. */
async function loadOverrides(): Promise<{ overrides: PriceOverrides; counts: Record<string, number> }> {
  const overrides: PriceOverrides = { fixed: new Map(), manual: new Map(), sales: new Map() };
  if (fs.existsSync(FIXED_CSV)) {
    for (const [key, price] of parseFixedPrices(fs.readFileSync(FIXED_CSV, "utf-8"))) {
      if (key.endsWith("|DE")) overrides.fixed.set(key, price);
    }
  }
  try {
    for (const manual of await loadManualPrices()) {
      if (manual.country?.toUpperCase() === "DE") overrides.manual.set(overrideKey(manual.sku), manual.price);
    }
  } catch (e) {
    const detail = `Sin precios manuales del panel (${String(e).slice(0, 120)})`;
    // En la aplicación no se puede decidir con overrides a medias: un precio manual que no llega cambia
    // el umbral de 35 € en las dos direcciones y el error solo se ve en la factura del cliente.
    if (APPLY) throw new Error(`${detail}: se aborta la aplicación para no decidir con overrides incompletos`);
    console.warn(`${detail}; la auditoría va sin ellos`);
  }
  overrides.sales = await loadSales();
  return { overrides, counts: { fixed: overrides.fixed.size, manual: overrides.manual.size, sales: overrides.sales.size } };
}

/** Informe maestro de DE en vivo: se pide, se espera y se descarga (TSV). */
async function fetchDeReport(): Promise<string> {
  const { reportId } = await createReport(client, { reportType: REPORT_TYPE, marketplaceIds: [DE_MARKETPLACE_ID] });
  console.log(`Informe ${REPORT_TYPE} pedido a Amazon (${reportId}); esperando…`);
  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    await sleep(POLL_MS);
    const status = await getReport(client, reportId);
    if (status.processingStatus === "DONE") {
      if (!status.reportDocumentId) throw new Error(`El informe ${reportId} terminó sin documento`);
      const document = await getReportDocument(client, status.reportDocumentId);
      const buffer = await downloadReportDocument(document);
      // Los flat files de Amazon vienen en latin1; los SKU y las columnas que usamos son ASCII.
      return buffer.toString("latin1");
    }
    if (status.processingStatus === "FATAL" || status.processingStatus === "CANCELLED") {
      throw new Error(`El informe ${reportId} terminó en ${status.processingStatus}`);
    }
  }
  throw new Error(`El informe ${reportId} no terminó en ${(MAX_POLLS * POLL_MS) / 1000}s; usa DE_REPORT_TSV con una copia`);
}

const money = (n: number | null) => (n == null ? "" : n.toFixed(2));
const topEntries = (counts: Record<string, number>, limit = 15) =>
  Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit);
const csvLine = (fields: string[]) =>
  fields.map((f) => (f.includes(",") || f.includes('"') ? `"${f.replaceAll('"', '""')}"` : f)).join(",");

interface AuditRow {
  row: DeReportRow;
  decision: RowDecision;
  family: string;
}

/** CSV de auditoría: una fila por SKU del informe, con la acción y las plantillas de origen y destino. */
function writeAuditCsv(rows: AuditRow[]): void {
  const lines = ["sku,asin,precio_informe,precio_efectivo,fuente_precio,grupo_actual,accion,motivo,familia,plantilla_origen,plantilla_destino"];
  for (const { row, decision, family } of rows) {
    lines.push(csvLine([
      row.sku,
      row.asin,
      money(row.price),
      money(decision.price),
      decision.source,
      row.group,
      decision.action,
      decision.motivo,
      family,
      decision.plantillaOrigen,
      decision.plantillaDestino,
    ]));
  }
  fs.writeFileSync(AUDIT_CSV, `${lines.join("\n")}\n`);
}

function printSummary(rows: AuditRow[], source: string, counts: Record<string, number>): void {
  const summary = summarize(rows.map(({ row, decision, family }) => ({ sku: row.sku, decision, family })));
  const accionPorMotivo = new Map(rows.map(({ decision }) => [decision.motivo, decision.action]));
  console.log(`\nENVÍO DE · ${APPLY ? "APLICACIÓN" : "AUDITORÍA"} | informe: ${source} | ${summary.rows} filas | overrides: ${counts.fixed} fijos, ${counts.manual} manuales, ${counts.sales} ofertas`);
  console.log(`  ${FREE_SHIPPING_GROUP} (gratis) → ${PAID_SHIPPING_GROUP} (pago) para FBM con precio efectivo < ${PRICE_LIMIT} €`);
  console.log(`  ok: ${summary.acciones.ok} · mover: ${summary.acciones.mover} · omitir: ${summary.acciones.omitir}`);
  for (const [motivo, n] of topEntries(summary.motivos)) {
    const action = accionPorMotivo.get(motivo) ?? "?";
    if (action === "mover") continue;
    console.log(`    ${action.padEnd(7)} ${n.toString().padStart(6)}  ${motivo}`);
  }
  const buckets = Object.entries(summary.buckets).filter(([bucket]) => bucket !== "≥35");
  console.log(`  a mover por precio: ${buckets.map(([b, n]) => `${b} ${n}`).join(" · ")}`);
  console.log("  a mover por familia:");
  for (const [family, n] of topEntries(summary.familias)) console.log(`    ${n.toString().padStart(6)}  ${family}`);
}

async function audit(rows: AuditRow[], source: string, counts: Record<string, number>): Promise<void> {
  writeAuditCsv(rows);
  const summary = summarize(rows.map(({ row, decision, family }) => ({ sku: row.sku, decision, family })));
  const movers = rows.filter((r) => r.decision.action === "mover");
  await writeSnapshot(AUDIT_KEY, {
    at: new Date().toISOString(),
    apply: false,
    source,
    marketplace: DE_MARKETPLACE_ID,
    rule: "FBM DE con precio efectivo < 35 € fuera de la plantilla de envío gratis",
    plantillas: { origen: FREE_SHIPPING_GROUP, destino: PAID_SHIPPING_GROUP, origenCobra: 0, destinoCobra: 3.99 },
    limit: PRICE_LIMIT,
    csv: path.basename(AUDIT_CSV),
    filas: summary.rows,
    overrides: counts,
    acciones: summary.acciones,
    motivos: summary.motivos,
    buckets: summary.buckets,
    familias: summary.familias,
    muestra: movers.slice(0, 50).map(({ row, decision }) => ({
      sku: row.sku,
      asin: row.asin,
      precio: decision.price,
      familia: skuFamily(row.sku),
      de: decision.plantillaOrigen,
      a: decision.plantillaDestino,
    })),
  });
  printSummary(rows, source, counts);
  console.log(`\nCSV: ${AUDIT_CSV} · resumen en Supabase ${AUDIT_KEY}`);
}

interface StateEntry {
  status: "ok" | "err";
  motivo: string;
  at: string;
  origen: string;
  destino: string;
}

function loadState(): Record<string, StateEntry> {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as Record<string, StateEntry>;
  } catch {
    console.warn(`Estado local ilegible (${STATE_FILE}); se empieza de cero`);
    return {};
  }
}

function saveState(state: Record<string, StateEntry>): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

const errorCode = (e: unknown): string => {
  const err = e as { errors?: Array<{ code?: string }>; statusCode?: number };
  return err?.errors?.[0]?.code ?? (err?.statusCode ? `HTTP ${err.statusCode}` : "ERROR");
};

/**
 * Fase de aplicación: re-lee cada listing y parchea solo si sigue en la plantilla de ENVÍO GRATIS, el
 * canal en vivo es FBM y el precio efectivo en vivo sigue por debajo de 35 €.
 */
async function apply(
  rows: AuditRow[],
  overrides: PriceOverrides,
  blocked: Set<string>,
  counts: Record<string, number>,
): Promise<void> {
  const state = loadState();
  const ahora = new Date();
  // Un `ok` caducado vuelve a entrar: si el PATCH se aceptó pero Amazon no lo aplicó (o el `ok` salió de
  // una lectura en vivo transitoria), el SKU sigue barato con envío gratis y no puede quedar fuera para siempre.
  const pending = rows.filter((r) => r.decision.action === "mover" && !stateIsFresh(state[r.row.sku], ahora, STATE_TTL_DAYS));
  // Los que nunca se han intentado van primero: si hay N errores permanentes (404, GPSR…) no pueden comerse
  // el tope de todas las pasadas y dejar el resto sin tocar. Los `err` se reintentan detrás, en la misma pasada.
  const batch = [...pending.filter((r) => !state[r.row.sku]), ...pending.filter((r) => state[r.row.sku])].slice(0, LIMIT);
  const resultados = { aplicado: 0, yaEnPago: 0, sinMover: 0, error: 0 };
  const errores: Array<{ sku: string; codigo: string; mensaje: string }> = [];
  const aplicados: Array<{ at: string; sku: string; origen: string; destino: string }> = [];

  console.log(`\nAplicando ${FREE_SHIPPING_GROUP} → ${PAID_SHIPPING_GROUP}: ${batch.length} SKU (${pending.length} pendientes, tope ${LIMIT}) · estado: ${STATE_FILE}`);
  let done = 0;
  await pool(batch, CONCURRENCY, async ({ row }) => {
    const sku = row.sku;
    const record = (status: StateEntry["status"], motivo: string, origen: string, destino = "") => {
      state[sku] = { status, motivo, at: ahora.toISOString(), origen, destino };
    };
    try {
      const listing = await getListingsItem(client, {
        sellerId: env.sellerId,
        sku,
        marketplaceIds: [DE_MARKETPLACE_ID],
        includedData: ["attributes", "summaries", "fulfillmentAvailability"],
      });
      const decision = liveDecision(sku, listing, row, overrides, { blocked, now: ahora });
      const origen = decision.plantillaOrigen || "";
      if (decision.action !== "mover") {
        // Entre la auditoría y el PATCH puede haber cambiado: precio por encima de 35, oferta quitada,
        // ya movido a la plantilla de pago o, incluso, ahora es FBA.
        if (decision.motivo === "sin oferta en vivo") {
          // No es una decisión: es no haber podido leer el precio. Se deja como `err` para reintentarlo en
          // la siguiente pasada en vez de dar el SKU por bueno con envío gratis.
          const mensaje = "el listing en vivo no tiene purchasable_offer (audiencia ALL) en DE";
          record("err", decision.motivo, origen);
          errores.push({ sku, codigo: "SIN_OFERTA", mensaje });
          resultados.error++;
          return;
        }
        record("ok", `en vivo: ${decision.motivo}`, origen);
        if (decision.motivo.startsWith("ya en plantilla de pago")) resultados.yaEnPago++;
        else resultados.sinMover++;
        return;
      }
      const patch = shippingGroupPatch(listingProductType(listing));
      const result = await patchListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [DE_MARKETPLACE_ID] }, patch);
      if (result.status === "ACCEPTED") {
        const desde = isFreeShippingGroup(origen) ? origen : FREE_SHIPPING_GROUP;
        record("ok", "PATCH aceptado", desde, PAID_SHIPPING_GROUP);
        aplicados.push({ at: ahora.toISOString(), sku, origen: desde, destino: PAID_SHIPPING_GROUP });
        resultados.aplicado++;
      } else {
        const issue = (result.issues ?? []).find((i) => i.severity === "ERROR") ?? result.issues?.[0];
        const codigo = issue?.code ?? result.status;
        const mensaje = issue?.message ?? `estado ${result.status}`;
        record("err", `${codigo}: ${mensaje}`, origen);
        errores.push({ sku, codigo, mensaje });
        resultados.error++;
      }
    } catch (e) {
      const codigo = isNotFound(e) ? "NOT_FOUND" : errorCode(e);
      const mensaje = String((e as Error)?.message ?? e).slice(0, 300);
      record("err", `${codigo}: ${mensaje}`, "");
      errores.push({ sku, codigo, mensaje });
      resultados.error++;
    } finally {
      done++;
      if (done % PROGRESS_EVERY === 0) {
        saveState(state);
        console.log(`  ${done}/${batch.length} · ${JSON.stringify(resultados)}`);
      }
    }
  });
  saveState(state);

  const lines = ["sku,codigo,mensaje", ...errores.map((e) => csvLine([e.sku, e.codigo, e.mensaje.replace(/[\r\n]+/g, " ")]))];
  fs.writeFileSync(ERRORS_CSV, `${lines.join("\n")}\n`);

  // Registro acumulado de lo que se cambió de verdad: el CSV de auditoría se reescribe en cada ejecución y
  // el informe maestro tarda en reflejarlo, así que sin esto no queda rastro del valor anterior.
  if (aplicados.length) {
    const header = fs.existsSync(APPLIED_CSV) ? "" : "at,sku,plantilla_origen,plantilla_destino\n";
    fs.appendFileSync(APPLIED_CSV, `${header}${aplicados.map((a) => csvLine([a.at, a.sku, a.origen, a.destino])).join("\n")}\n`);
  }

  await writeSnapshot(APPLY_KEY, {
    at: new Date().toISOString(),
    apply: true,
    marketplace: DE_MARKETPLACE_ID,
    plantillas: { origen: FREE_SHIPPING_GROUP, destino: PAID_SHIPPING_GROUP, origenCobra: 0, destinoCobra: 3.99 },
    limit: PRICE_LIMIT,
    overrides: counts,
    estadoTtlDias: STATE_TTL_DAYS,
    pendientes: pending.length,
    intentados: batch.length,
    resultados,
    aplicados: { total: aplicados.length, csv: path.basename(APPLIED_CSV), muestra: aplicados.slice(0, 50) },
    errores: errores.slice(0, 200),
  });

  console.log(`\nAplicación terminada: ${JSON.stringify(resultados)}`);
  console.log(`Errores (${errores.length}): ${ERRORS_CSV} · cambios aceptados: ${aplicados.length} → ${APPLIED_CSV} · resumen en Supabase ${APPLY_KEY}`);
  if (pending.length > batch.length) console.log(`Quedan ${pending.length - batch.length} SKU para la siguiente ejecución (tope SHIPPING_GROUP_LIMIT=${LIMIT}).`);
  for (const error of errores.slice(0, 20)) console.log(`  ${error.sku} · ${error.codigo} · ${error.mensaje}`);
}

async function main(): Promise<void> {
  if (APPLY && LIMIT > CONFIRM_FROM_LIMIT && !CONFIRM) {
    throw new Error(
      `Tope ${LIMIT} > ${CONFIRM_FROM_LIMIT} SKU: confirma el lote grande con SHIPPING_GROUP_CONFIRM=1 ` +
        `o baja SHIPPING_GROUP_LIMIT (recomendado empezar por 25).`,
    );
  }
  requireFile(BLOCKED_FILE, "la lista de SKU retirados (blocked_skus.txt)");
  requireFile(FIXED_CSV, "el fichero de precios fijos (fixed_prices.csv)");
  const source = REPORT_TSV ?? "Reports API (GET_MERCHANT_LISTINGS_ALL_DATA)";
  const text = REPORT_TSV ? fs.readFileSync(REPORT_TSV, "utf-8") : await fetchDeReport();
  const reportRows = parseDeReportTsv(text);
  const blocked = blockedSkusFromText(fs.readFileSync(BLOCKED_FILE, "utf-8"));
  const { overrides, counts } = await loadOverrides();
  const now = new Date();
  const rows: AuditRow[] = reportRows.map((row) => ({
    row,
    decision: decideRow(row, overrides, { blocked, now }),
    family: skuFamily(row.sku),
  }));

  console.log(`ENVÍO DE · ${APPLY ? "APLICACIÓN" : "AUDITORÍA"} · ${reportRows.length} filas de ${source}`);
  await audit(rows, source, counts);
  if (APPLY) await apply(rows, overrides, blocked, counts);
}

main().then(() => process.exit(0), (e) => {
  console.error(e);
  process.exit(1);
});
