/**
 * Paso 1 de la limpieza de listings (ver scripts/lib/listing-cleanup.ts): elige los SKU
 * creados hasta MAX_YEAR sin ventas desde 2025 y sin stock, los revisa en vivo en todos los
 * marketplaces EU y archiva los que se pueden borrar. No borra nada en Amazon.
 *
 * Env:
 *   CATALOG_CSV   → catalogo_completo.csv (por defecto ../catalogo_completo.csv).
 *   SALES_CSVS    → ventas separadas por comas (por defecto ../ventas_2025.csv,../ventas_2026.csv).
 *   MAX_YEAR      → último año de creación incluido (por defecto 2024).
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY → archivo en la tabla snapshots.
 *
 * Es reanudable: los SKU ya archivados no se vuelven a consultar.
 * REFRESH_ARCHIVED=1 → en vez de buscar candidatos nuevos, vuelve a consultar los archivados (aún sin
 *   borrar) que no guardan el contenido de la ficha y los rehace con todos los atributos; si alguno ya
 *   no cumple los criterios queda como "kept" y no se borra.
 * Deja en la raíz del repo listings_a_borrar_<fecha>.csv y listings_excluidos_<fecha>.csv.
 */
import fs from "node:fs";
import path from "node:path";
import { env } from "../src/config/env";
import { SpApiClient } from "../src/spapi/client";
import { loadArchive, saveRecords, usesSupabase } from "./lib/listing-archive-store";
import { cleanupApi, pool } from "./lib/listing-cleanup-api";
import {
  addSales,
  type ArchiveRecord,
  archiveRecord,
  type CatalogCandidate,
  hasContent,
  catalogCandidates,
  keepReason,
} from "./lib/listing-cleanup";

const root = path.resolve(process.cwd(), "..");
const CATALOG = process.env.CATALOG_CSV ?? path.join(root, "catalogo_completo.csv");
const SALES = (process.env.SALES_CSVS ?? `${path.join(root, "ventas_2025.csv")},${path.join(root, "ventas_2026.csv")}`).split(",");
const MAX_YEAR = Number(process.env.MAX_YEAR ?? 2024);
const REFRESH = process.env.REFRESH_ARCHIVED === "1";
const client = new SpApiClient({ credentials: env.spApi });
const { fetchListing, fbaUnits } = cleanupApi(client, env.sellerId);

const csvCell = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
function writeCsv(file: string, header: string[], rows: unknown[][]): void {
  fs.writeFileSync(file, `\uFEFF${[header, ...rows].map((r) => r.map(csvCell).join(";")).join("\n")}\n`);
}

/** Rehace con todos los atributos los archivados (sin borrar) que no guardan contenido de ficha. */
async function refresh(now: string) {
  const stale = [...(await loadArchive()).values()].filter((r) => r.status === "archived" && !hasContent(r));
  console.log(`Archivados sin contenido de ficha: ${stale.length}`);
  const fba = await fbaUnits(stale.filter((r) => r.channel === "FBA").map((r) => r.sku));
  const counts: Record<string, number> = {};
  let buffer: ArchiveRecord[] = [];
  let done = 0;
  await pool(stale, 8, async (rec) => {
    let listing: any;
    try {
      listing = await fetchListing(rec.sku);
    } catch (e) {
      counts.error = (counts.error ?? 0) + 1;
      return;
    }
    const why = keepReason(listing, fba.get(rec.sku) ?? 0);
    const base = { sku: rec.sku, asin: rec.asin, openDate: rec.openDate, channel: rec.channel, catalogStatus: "", catalogQuantity: 0, price: "", name: rec.name };
    const next: ArchiveRecord = why
      ? { ...rec, status: "kept", keptReason: why }
      : { ...archiveRecord(base, listing, rec.archivedAt), archivedAt: rec.archivedAt };
    const key = why ? `kept: ${why.replace(/\d+/g, "N")}` : hasContent(next) ? "con contenido" : "sin contenido en Amazon";
    counts[key] = (counts[key] ?? 0) + 1;
    buffer.push(next);
    if (buffer.length >= 200) { const b = buffer; buffer = []; await saveRecords(b); }
    if (++done % 1000 === 0) console.log(`  ${done}/${stale.length}`);
  });
  await saveRecords(buffer);
  console.log(`Rehechos: ${JSON.stringify(counts)} (${now})`);
}

async function main() {
  const now = new Date().toISOString();
  if (REFRESH) return refresh(now);
  const sales = { skus: new Set<string>(), asins: new Set<string>() };
  for (const f of SALES) addSales(sales, fs.readFileSync(f, "utf-8"));
  const candidates = catalogCandidates(fs.readFileSync(CATALOG, "utf-8"), sales, MAX_YEAR);
  const archive = await loadArchive();
  const pending = candidates.filter((c) => !archive.has(c.sku));
  console.log(`Candidatos ${candidates.length} (creados ≤${MAX_YEAR}, sin ventas, stock FBM 0) | ya archivados ${candidates.length - pending.length} | a revisar ${pending.length} | Supabase ${usesSupabase ? "sí" : "no (solo local)"}`);

  const fba = await fbaUnits(pending.filter((c) => c.channel === "FBA").map((c) => c.sku));
  const excluded: Array<[CatalogCandidate, string]> = [];
  let buffer: ArchiveRecord[] = [];
  let done = 0;
  const flush = async () => { const b = buffer; buffer = []; await saveRecords(b); };

  await pool(pending, 8, async (c) => {
    let reason: string | null;
    let listing: any = null;
    try {
      listing = await fetchListing(c.sku);
      reason = keepReason(listing, fba.get(c.sku) ?? 0);
    } catch (e) {
      reason = `error: ${String(e).slice(0, 150)}`;
    }
    if (reason) excluded.push([c, reason]);
    else buffer.push(archiveRecord(c, listing, now));
    if (buffer.length >= 200) await flush();
    if (++done % 500 === 0) console.log(`  ${done}/${pending.length}`);
  });
  await flush();

  const all = [...(await loadArchive()).values()].filter((r) => r.status === "archived").sort((a, b) => a.openDate.localeCompare(b.openDate));
  const day = now.slice(0, 10);
  writeCsv(path.join(root, `listings_a_borrar_${day}.csv`), ["sku", "asin", "canal", "fecha_creacion", "marketplaces", "tipo_producto", "precio_es", "producto"],
    all.map((r) => [r.sku, r.asin, r.channel, r.openDate, r.marketplaces.map((m) => m.code).join(","), r.marketplaces[0]?.productType, r.marketplaces.find((m) => m.code === "ES")?.price, r.name]));
  writeCsv(path.join(root, `listings_excluidos_${day}.csv`), ["sku", "asin", "canal", "fecha_creacion", "motivo", "producto"],
    excluded.map(([c, why]) => [c.sku, c.asin, c.channel, c.openDate, why, c.name]));

  const reasons: Record<string, number> = {};
  for (const [, why] of excluded) { const k = why.replace(/\d+/g, "N").replace(/^error:.*/, "error"); reasons[k] = (reasons[k] ?? 0) + 1; }
  console.log(`Archivados (listos para borrar): ${all.length} | excluidos en esta pasada: ${excluded.length} ${JSON.stringify(reasons)}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
