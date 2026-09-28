/**
 * Paso 2 de la limpieza de listings: borra en Amazon, por tandas, los SKU archivados por
 * archive-stale-listings.ts. Antes de borrar cada uno lo vuelve a comprobar en vivo (stock
 * FBM/FBA, variación, BUYABLE) y lo borra en todos los marketplaces EU donde existe.
 *
 * Por defecto no borra nada: solo lista lo que borraría.
 * Env:
 *   LISTINGS_DELETE_APPLY=1 → borra de verdad.
 *   LIMIT                   → SKU por tanda (por defecto 2000), del más antiguo al más reciente.
 */
import { env } from "../src/config/env";
import { SpApiClient } from "../src/spapi/client";
import { deleteListingsItem } from "../src/spapi/endpoints/listingsItems";
import { loadArchive, saveRecords } from "./lib/listing-archive-store";
import { cleanupApi, pool } from "./lib/listing-cleanup-api";
import { type ArchiveRecord, CLEANUP_MARKETPLACES, codeForMarketplace, keepReason } from "./lib/listing-cleanup";

const APPLY = process.env.LISTINGS_DELETE_APPLY === "1";
const LIMIT = Number(process.env.LIMIT ?? 2000);
const client = new SpApiClient({ credentials: env.spApi });
const { fetchListing, fbaUnits } = cleanupApi(client, env.sellerId);

async function main() {
  const archive = await loadArchive();
  const batch = [...archive.values()].filter((r) => r.status === "archived").sort((a, b) => a.openDate.localeCompare(b.openDate)).slice(0, LIMIT);
  console.log(`${APPLY ? "BORRADO" : "SIMULACIÓN"} | archivados pendientes ${[...archive.values()].filter((r) => r.status === "archived").length} | tanda ${batch.length}`);
  const fba = await fbaUnits(batch.filter((r) => r.channel === "FBA").map((r) => r.sku));
  const summary: Record<string, number> = {};
  const count = (k: string) => { summary[k] = (summary[k] ?? 0) + 1; };
  let buffer: ArchiveRecord[] = [];

  await pool(batch, 5, async (rec) => {
    let listing: any;
    try {
      listing = await fetchListing(rec.sku);
    } catch (e) {
      count("error al consultar");
      console.log(`  ${rec.sku}: error al consultar ${String(e).slice(0, 150)}`);
      return;
    }
    if (!listing) {
      // Ya no existe en Amazon (borrado a mano): queda como borrado.
      buffer.push({ ...rec, status: "deleted", deletedAt: new Date().toISOString(), deletions: [...(rec.deletions ?? []), { code: "ES", result: "ya no existía" }] });
      count("ya no existía");
      return;
    }
    const why = keepReason(listing, fba.get(rec.sku) ?? 0);
    if (why) {
      count(`se mantiene: ${why.replace(/\d+/g, "N")}`);
      console.log(`  ${rec.sku}: se mantiene (${why})`);
      return;
    }
    const codes = (listing.summaries as any[]).map((s) => codeForMarketplace(s.marketplaceId)).filter((c): c is keyof typeof CLEANUP_MARKETPLACES => Boolean(c));
    if (!APPLY) {
      count("se borraría");
      return;
    }
    const deletions: NonNullable<ArchiveRecord["deletions"]> = [];
    for (const code of codes) {
      try {
        const r = await deleteListingsItem(client, { sellerId: env.sellerId, sku: rec.sku, marketplaceIds: [CLEANUP_MARKETPLACES[code]] });
        deletions.push({ code, result: r.status, submissionId: r.submissionId, detail: r.issues?.length ? JSON.stringify(r.issues).slice(0, 300) : undefined });
      } catch (e) {
        deletions.push({ code, result: "error", detail: String(e).slice(0, 300) });
      }
    }
    const ok = deletions.every((d) => d.result === "ACCEPTED");
    count(ok ? "borrado" : "borrado con errores");
    if (!ok) console.log(`  ${rec.sku}: ${JSON.stringify(deletions.filter((d) => d.result !== "ACCEPTED"))}`);
    buffer.push({ ...rec, status: ok ? "deleted" : "archived", deletedAt: ok ? new Date().toISOString() : undefined, deletions: [...(rec.deletions ?? []), ...deletions] });
    if (buffer.length >= 200) { const b = buffer; buffer = []; await saveRecords(b); }
  });
  await saveRecords(buffer);
  console.log(JSON.stringify(summary));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
