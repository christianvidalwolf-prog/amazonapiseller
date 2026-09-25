/** Publish every history exposed by the catalog; never silently skip failed products. */
import { isMarketplaceMissingAsinError } from "./amazon-errors";

export async function publishBsrSnapshots(
  readPayload: (path: string) => Promise<unknown>,
  writeSnapshot: (key: string, data: unknown) => Promise<void>
): Promise<number> {
  const catalog = await readPayload("/api/bsr/catalog");
  if (!Array.isArray(catalog) || catalog.some((item) => !item || typeof item.asin !== "string" || !item.asin)) {
    throw new Error("Invalid BSR catalog payload");
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
        const history = await readPayload(`/api/bsr/history/${encodeURIComponent(asin)}?days=90`);
        await writeSnapshot(`bsr:history:${asin}`, history);
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
  await writeSnapshot("bsr:catalog", availableCatalog);
  return availableCatalog.length + 1;
}
