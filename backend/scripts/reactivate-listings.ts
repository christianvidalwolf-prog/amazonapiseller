/**
 * Paso 3 de la limpieza de listings: vuelve a crear la oferta de SKU borrados cuando
 * reaparecen con stock. La oferta se crea sobre el mismo ASIN (LISTING_OFFER_ONLY) y con el
 * mismo SKU; después la sincronización diaria de stock (sync_daily_stock_amz.py) la mantiene
 * como a cualquier otro SKU.
 *
 * Qué SKU:
 *   (por defecto)   → FBM borrados con quantity > 0 en la última copia del STOCK AMZ que
 *                     sync_daily_stock_amz.py publica en Supabase (stock:latest:*). Es lo que
 *                     ejecuta el workflow programado, sin depender de ningún ordenador.
 *   STOCK_FILE=...  → igual, pero con un STOCK AMZ exportado a .txt/.csv.
 *   SKUS=a,b,c      → estos SKU (FBM o FBA), tengan o no stock.
 * Dónde: con stock, en ES/DE/FR/IT (los países que mantiene la sincronización diaria) si el SKU
 *        existía allí; con SKUS, en todos los países en euros donde existía.
 * Precio: FBM con stock → precio del fichero + recargo del país (ES 0, DE +5, FR +6, IT +7);
 *         en otro caso, el precio archivado de ese país.
 *
 * Env:
 *   LISTINGS_REACTIVATE_APPLY=1 → publica; si no, solo valida (VALIDATION_PREVIEW).
 *   MAX_STOCK_AGE_HOURS         → antigüedad máxima de la copia de stock (por defecto 48).
 *   MAX_REACTIVATIONS           → tope de SKU por ejecución (por defecto 300; el resto, en la siguiente).
 * Informe en Supabase: rules:listings-reactivation:last-run.
 */
import fs from "node:fs";
import { env } from "../src/config/env";
import { SpApiClient } from "../src/spapi/client";
import { previewListingsItem, putListingsItem } from "../src/spapi/endpoints/listingsItems";
import { copyAttributesFor } from "./lib/fba-replication";
import { loadArchive, loadStockSnapshot, saveRecords, writeSnapshot } from "./lib/listing-archive-store";
import { cleanupApi } from "./lib/listing-cleanup-api";
import {
  type ArchiveRecord,
  AUTO_REACTIVATE_MARKETPLACES,
  CLEANUP_MARKETPLACES,
  type MarketplaceCode,
  parseStockFile,
  reactivationPayload,
  reactivationPrice,
  type StockFileRow,
  stockFromSnapshotItems,
} from "./lib/listing-cleanup";

const APPLY = process.env.LISTINGS_REACTIVATE_APPLY === "1";
const STOCK_FILE = process.env.STOCK_FILE;
const SKUS = (process.env.SKUS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_AGE_HOURS = Number(process.env.MAX_STOCK_AGE_HOURS ?? 48);
const MAX_REACTIVATIONS = Number(process.env.MAX_REACTIVATIONS ?? 300);
const REPORT_KEY = "rules:listings-reactivation:last-run";
/** Países en euros: la oferta se crea con currency EUR (PL, SE, UK y TR usan otra moneda). */
const EUR_MARKETPLACES: MarketplaceCode[] = ["ES", "DE", "FR", "IT", "NL", "BE", "IE"];
const client = new SpApiClient({ credentials: env.spApi });
const { fetchListing } = cleanupApi(client, env.sellerId);

const errorsOf = (r: any) => (r.issues ?? []).filter((i: any) => i.severity === "ERROR");

async function loadStock(): Promise<{ stock: Map<string, StockFileRow>; source: string } | { skip: string }> {
  if (STOCK_FILE) return { stock: parseStockFile(fs.readFileSync(STOCK_FILE, "utf-8")), source: STOCK_FILE };
  const snap = await loadStockSnapshot();
  if (!snap) return { skip: "no hay copia de stock completa en Supabase (stock:latest:*)" };
  const ageHours = (Date.now() - Date.parse(snap.updatedAt)) / 3_600_000;
  if (!(ageHours <= MAX_AGE_HOURS)) return { skip: `la copia de stock es de ${snap.updatedAt} (más de ${MAX_AGE_HOURS} h)` };
  return { stock: stockFromSnapshotItems(snap.items), source: `Supabase ${snap.sourceFile} (${snap.updatedAt})` };
}

async function reactivate(rec: ArchiveRecord, row: StockFileRow | undefined, codes: MarketplaceCode[]) {
  const results: NonNullable<ArchiveRecord["reactivations"]> = [];
  // Una sola consulta para ver en qué países ya existe (recreado a mano, por ejemplo).
  const live = await fetchListing(rec.sku);
  const existing = new Set((live?.summaries ?? []).map((s: any) => s.marketplaceId));
  for (const code of codes) {
    const mid = CLEANUP_MARKETPLACES[code];
    if (existing.has(mid)) { results.push({ code, result: "ya existe" }); continue; }
    const price = reactivationPrice(rec, code, row);
    if (price == null) { results.push({ code, result: "sin precio" }); continue; }
    let payload: any = reactivationPayload(rec, code, price, row?.quantity ?? 0);
    const params = { sellerId: env.sellerId, sku: rec.sku, marketplaceIds: [mid] };
    try {
      let check = await previewListingsItem(client, params, payload);
      // Si Amazon pide atributos de cumplimiento que el listing ya tenía, se copian del archivo.
      const missing: string[] = errorsOf(check).flatMap((i: any) => i.attributeNames ?? []);
      const extra = copyAttributesFor(rec.attributes as any, missing, mid);
      if (check.status !== "VALID" && Object.keys(extra).length) {
        payload = { ...payload, attributes: { ...payload.attributes, ...extra } };
        check = await previewListingsItem(client, params, payload);
      }
      if (check.status !== "VALID") {
        results.push({ code, result: "no válido", detail: errorsOf(check).map((i: any) => `${i.code} ${i.attributeNames?.join(",") ?? ""}: ${i.message}`).join(" | ").slice(0, 400) });
        continue;
      }
      if (!APPLY) { results.push({ code, result: `válido (precio ${price})` }); continue; }
      const r = await putListingsItem(client, params, payload);
      results.push({ code, result: r.status, submissionId: r.submissionId, detail: errorsOf(r).length ? JSON.stringify(errorsOf(r)).slice(0, 300) : undefined });
    } catch (e) {
      results.push({ code, result: "error", detail: String(e).slice(0, 300) });
    }
  }
  return results;
}

async function main() {
  const at = new Date().toISOString();
  let stock = new Map<string, StockFileRow>();
  let source = "SKUS";
  if (!SKUS.length) {
    const loaded = await loadStock();
    if ("skip" in loaded) {
      console.log(`Reactivación omitida: ${loaded.skip}`);
      await writeSnapshot(REPORT_KEY, { at, apply: APPLY, skipped: loaded.skip });
      return;
    }
    ({ stock, source } = loaded);
  }

  const archive = await loadArchive();
  const deleted = [...archive.values()].filter((r) => r.status === "deleted");
  const wanted = SKUS.length
    ? SKUS.map((s) => archive.get(s)).filter((r): r is ArchiveRecord => Boolean(r && r.status === "deleted"))
    : deleted.filter((r) => r.channel === "FBM" && (stock.get(r.sku)?.quantity ?? 0) > 0);
  if (SKUS.length && wanted.length < SKUS.length) {
    console.log(`Sin registro borrado para: ${SKUS.filter((s) => !wanted.some((t) => t.sku === s)).join(", ")}`);
  }
  const targets = wanted.slice(0, MAX_REACTIVATIONS);
  console.log(`${APPLY ? "PUBLICAR" : "VALIDAR"} | stock: ${source} | borrados en archivo ${deleted.length} | con stock ${wanted.length} | en esta ejecución ${targets.length}`);

  const updated: ArchiveRecord[] = [];
  const items: any[] = [];
  for (const rec of targets) {
    const row = stock.get(rec.sku);
    const allowed = SKUS.length ? EUR_MARKETPLACES : AUTO_REACTIVATE_MARKETPLACES;
    const codes = rec.marketplaces.map((m) => m.code).filter((c) => allowed.includes(c));
    if (!codes.length) { items.push({ sku: rec.sku, result: "sin país en euros donde recrearlo" }); continue; }
    const results = await reactivate(rec, row, codes);
    console.log(`  ${rec.sku} (${rec.channel}, ${rec.asin}): ${results.map((r) => `${r.code} ${r.result}${r.detail ? ` [${r.detail}]` : ""}`).join(" · ")}`);
    items.push({ sku: rec.sku, asin: rec.asin, stock: row?.quantity, precio_base: row?.price, results });
    // Recreado (o ya existente) en algún país: sale del archivo de borrados.
    if (APPLY && results.some((r) => r.result === "ACCEPTED" || r.result === "ya existe")) {
      updated.push({ ...rec, status: "reactivated", reactivatedAt: at, reactivations: [...(rec.reactivations ?? []), ...results] });
    }
  }
  await saveRecords(updated);
  const summary: Record<string, number> = {};
  for (const it of items) for (const r of it.results ?? [{ result: it.result }]) summary[r.result] = (summary[r.result] ?? 0) + 1;
  await writeSnapshot(REPORT_KEY, { at, apply: APPLY, source, deleted: deleted.length, withStock: wanted.length, processed: targets.length, reactivated: updated.length, summary, items });
  console.log(`Reactivados: ${updated.length} | ${JSON.stringify(summary)}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
