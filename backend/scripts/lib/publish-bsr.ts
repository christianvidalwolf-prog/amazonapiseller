/**
 * Publish every history exposed by the catalog; never silently skip failed products.
 *
 * Sin marketplace publica el marketplace por defecto con las claves de siempre
 * (bsr:catalog, bsr:history:<asin>). Con marketplace ("DE"…) usa claves con el
 * código (bsr:catalog:DE, bsr:history:DE:<asin>) y solo publica productos que
 * tienen ranking en ese país: el resto no está a la venta allí.
 */
import { isMarketplaceMissingAsinError } from "./amazon-errors";

export async function publishBsrSnapshots(
  readPayload: (path: string) => Promise<unknown>,
  writeSnapshot: (key: string, data: unknown) => Promise<void>,
  marketplace?: string
): Promise<number> {
  const query = marketplace ? `&marketplace=${encodeURIComponent(marketplace)}` : "";
  const keyPrefix = marketplace ? `${marketplace}:` : "";
  const rawCatalog = await readPayload(marketplace ? `/api/bsr/catalog?fetchAll=true${query}` : "/api/bsr/catalog");
  if (!Array.isArray(rawCatalog) || rawCatalog.some((item) => !item || typeof item.asin !== "string" || !item.asin)) {
    throw new Error("Invalid BSR catalog payload");
  }
  const catalog = marketplace
    ? rawCatalog.filter((item) => item.rootCategory?.rank || item.detailCategory?.rank)
    : rawCatalog;

  const weekly = await readPayload(`/api/bsr/weekly${marketplace ? `?marketplace=${encodeURIComponent(marketplace)}` : ""}`);
  if (!weekly || typeof weekly !== "object" || !Array.isArray((weekly as { products?: unknown }).products)) {
    throw new Error("Invalid BSR weekly payload");
  }

  const failures: Error[] = [];
  const asins = Array.from(new Set<string>(catalog.map((item) => item.asin)));
  const availableMap = new Map<string, unknown>();

  // Process with controlled concurrency (10 parallel workers) so ~3,700 items
  // finish in a few minutes instead of over 1.5 hours sequentially.
  const CONCURRENCY = 10;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < asins.length) {
      const idx = cursor++;
      const asin = asins[idx];
      try {
        const history = await readPayload(`/api/bsr/history/${encodeURIComponent(asin)}?days=90${query}`);
        await writeSnapshot(`bsr:history:${keyPrefix}${asin}`, history);
        const item = catalog.find((i) => i.asin === asin);
        if (item) availableMap.set(asin, item);
      } catch (error) {
        if (isMarketplaceMissingAsinError(error)) continue;
        failures.push(new Error(`${asin}: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  if (failures.length) {
    throw new Error(`Failed to publish ${failures.length} BSR histories: ${failures.map((error) => error.message).join("; ")}`);
  }

  // Preserve catalog order
  const availableCatalog = catalog.filter((item) => availableMap.has(item.asin));
  await writeSnapshot(marketplace ? `bsr:weekly:${marketplace}` : "bsr:weekly", weekly);
  await writeSnapshot(marketplace ? `bsr:catalog:${marketplace}` : "bsr:catalog", availableCatalog);
  return availableCatalog.length + 2;
}
