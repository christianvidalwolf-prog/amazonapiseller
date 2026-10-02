/**
 * Recupera el contenido de ficha (viñetas, descripción, imágenes…) de los listings ya borrados
 * cuyo registro de archivo es anterior a la v2 y no lo guardaba. Lo toma de la API de Catálogo
 * en los países donde la ficha del ASIN aún existe; las imágenes se copian también a los países
 * donde la ficha ha desaparecido, porque no dependen del idioma.
 *
 * Solo lee de Amazon y escribe en el archivo (Supabase + copia local). Reanudable: los registros
 * ya procesados llevan `contentRecoveredAt`.
 */
import { env } from "../src/config/env";
import { SpApiClient } from "../src/spapi/client";
import { getCatalogItem } from "../src/spapi/endpoints/catalogItems";
import { loadArchive, saveRecords } from "./lib/listing-archive-store";
import { pool } from "./lib/listing-cleanup-api";
import { type ArchiveRecord, CLEANUP_MARKETPLACES, hasContent, mergeCatalogContent } from "./lib/listing-cleanup";

const client = new SpApiClient({ credentials: env.spApi });

async function main() {
  const all = [...(await loadArchive()).values()];
  const todo = all.filter((r) => r.status === "deleted" && !hasContent(r) && !r.contentRecoveredAt);
  console.log(`Borrados sin contenido de ficha: ${todo.length}`);
  const counts: Record<string, number> = {};
  const count = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  let buffer: ArchiveRecord[] = [];
  let done = 0;

  await pool(todo, 2, async (rec) => {
    const ids = rec.marketplaces.map((m) => CLEANUP_MARKETPLACES[m.code]);
    let item: any = null;
    try {
      item = await getCatalogItem(client, { asin: rec.asin, marketplaceIds: ids, includedData: ["attributes", "images", "summaries"] });
    } catch (e) {
      if (!/NOT_FOUND|not found|404/i.test(String(e))) { count("error"); return; }
    }
    const next = mergeCatalogContent(rec, item, new Date().toISOString());
    const withPage = next.contentFrom ?? [];
    count(withPage.length ? (withPage.length === rec.marketplaces.length ? "ficha en todos sus países" : "ficha solo en algunos países") : "sin ficha en ningún país");
    buffer.push(next);
    if (buffer.length >= 200) { const b = buffer; buffer = []; await saveRecords(b); }
    if (++done % 250 === 0) console.log(`  ${done}/${todo.length} ${JSON.stringify(counts)}`);
  });
  await saveRecords(buffer);
  console.log(`Recuperados: ${JSON.stringify(counts)}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
