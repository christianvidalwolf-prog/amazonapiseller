/**
 * Paso 3 de la limpieza de listings: vuelve a crear la oferta de SKU borrados cuando
 * reaparecen con stock. La oferta se crea sobre el mismo ASIN (LISTING_OFFER_ONLY) y con el
 * mismo SKU, en los marketplaces donde estaba; después la sincronización diaria de stock
 * (sync_daily_stock_amz.py) la mantiene como a cualquier otro SKU.
 *
 * Qué SKU:
 *   STOCK_FILE=<STOCK AMZ exportado a .txt/.csv> → los FBM borrados con quantity > 0 en el fichero.
 *   SKUS=a,b,c                                    → estos SKU (FBM o FBA), tengan o no stock en el fichero.
 * Precio: FBM con STOCK_FILE → precio del fichero + recargo del país (ES 0, DE +5, FR +6, IT +7);
 *         en otro caso, el precio archivado de ese marketplace.
 *
 * Por defecto solo valida (VALIDATION_PREVIEW). LISTINGS_REACTIVATE_APPLY=1 → publica.
 */
import fs from "node:fs";
import { env } from "../src/config/env";
import { SpApiClient } from "../src/spapi/client";
import { previewListingsItem, putListingsItem } from "../src/spapi/endpoints/listingsItems";
import { copyAttributesFor } from "./lib/fba-replication";
import { loadArchive, saveRecords } from "./lib/listing-archive-store";
import {
  type ArchiveRecord,
  CLEANUP_MARKETPLACES,
  parseStockFile,
  reactivationPayload,
  reactivationPrice,
  type StockFileRow,
} from "./lib/listing-cleanup";

const APPLY = process.env.LISTINGS_REACTIVATE_APPLY === "1";
const STOCK_FILE = process.env.STOCK_FILE;
const SKUS = (process.env.SKUS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const client = new SpApiClient({ credentials: env.spApi });

const errorsOf = (r: any) => (r.issues ?? []).filter((i: any) => i.severity === "ERROR");

async function main() {
  if (!STOCK_FILE && !SKUS.length) throw new Error("Indica STOCK_FILE (STOCK AMZ exportado) o SKUS=a,b,c");
  const stock = STOCK_FILE ? parseStockFile(fs.readFileSync(STOCK_FILE, "utf-8")) : new Map<string, StockFileRow>();
  const archive = await loadArchive();
  const deleted = [...archive.values()].filter((r) => r.status === "deleted");
  const targets = SKUS.length
    ? SKUS.map((s) => archive.get(s)).filter((r): r is ArchiveRecord => Boolean(r && r.status === "deleted"))
    : deleted.filter((r) => r.channel === "FBM" && (stock.get(r.sku)?.quantity ?? 0) > 0);
  if (SKUS.length && targets.length < SKUS.length) {
    console.log(`Sin registro borrado para: ${SKUS.filter((s) => !targets.some((t) => t.sku === s)).join(", ")}`);
  }
  console.log(`${APPLY ? "PUBLICAR" : "VALIDAR"} | borrados en archivo ${deleted.length} | a reactivar ${targets.length}`);

  const updated: ArchiveRecord[] = [];
  for (const rec of targets) {
    const row = stock.get(rec.sku);
    const results: NonNullable<ArchiveRecord["reactivations"]> = [];
    for (const m of rec.marketplaces) {
      const mid = CLEANUP_MARKETPLACES[m.code];
      const price = reactivationPrice(rec, m.code, row);
      if (price == null) { results.push({ code: m.code, result: "sin precio" }); continue; }
      let payload: any = reactivationPayload(rec, m.code, price, row?.quantity ?? 0);
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
          results.push({ code: m.code, result: "no válido", detail: errorsOf(check).map((i: any) => `${i.code} ${i.attributeNames?.join(",") ?? ""}: ${i.message}`).join(" | ").slice(0, 400) });
          continue;
        }
        if (!APPLY) { results.push({ code: m.code, result: `válido (precio ${price})` }); continue; }
        const r = await putListingsItem(client, params, payload);
        results.push({ code: m.code, result: r.status, submissionId: r.submissionId });
      } catch (e) {
        results.push({ code: m.code, result: "error", detail: String(e).slice(0, 300) });
      }
    }
    console.log(`  ${rec.sku} (${rec.channel}, ${rec.asin}): ${results.map((r) => `${r.code} ${r.result}${r.detail ? ` [${r.detail}]` : ""}`).join(" · ")}`);
    if (APPLY && results.some((r) => r.result === "ACCEPTED")) {
      updated.push({ ...rec, status: "reactivated", reactivatedAt: new Date().toISOString(), reactivations: [...(rec.reactivations ?? []), ...results] });
    }
  }
  await saveRecords(updated);
  if (APPLY) console.log(`Reactivados: ${updated.length}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
