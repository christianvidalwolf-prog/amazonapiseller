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
  const availableCatalog = [];
  const asins = new Set<string>(catalog.map((item) => item.asin));
  for (const asin of asins) {
    try {
      const history = await readPayload(`/api/bsr/history/${encodeURIComponent(asin)}?days=90`);
      await writeSnapshot(`bsr:history:${asin}`, history);
      availableCatalog.push(catalog.find((item) => item.asin === asin));
    } catch (error) {
      if (isMarketplaceMissingAsinError(error)) continue;
      failures.push(new Error(`${asin}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  if (failures.length) {
    throw new Error(`Failed to publish ${failures.length} BSR histories: ${failures.map((error) => error.message).join("; ")}`);
  }

  // Only expose products after their histories are available.
  await writeSnapshot("bsr:catalog", availableCatalog);
  return availableCatalog.length + 1;
}
