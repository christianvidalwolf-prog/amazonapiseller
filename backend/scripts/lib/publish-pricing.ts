import type { PricingDashboardSummary } from "../../src/modules/pricing/pricing.service";

export async function publishPricingSnapshots(
  readPayload: (path: string) => Promise<unknown>,
  writeSnapshot: (key: string, data: unknown) => Promise<void>
): Promise<number> {
  const summary = await readPayload("/api/pricing/summary?limit=40&force=true") as PricingDashboardSummary;
  if (!summary || !Array.isArray(summary.products)) throw new Error("Invalid pricing summary");
  await writeSnapshot("pricing:summary", summary);
  const failures: string[] = [];
  let publishedOffers = 0;
  const asins = new Set(summary.products.map((product) => product.asin));
  for (const asin of asins) {
    try {
      const detail = await readPayload(`/api/pricing/offers?asin=${encodeURIComponent(asin)}`);
      await writeSnapshot(`pricing:offers:${asin}`, detail);
      publishedOffers += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Catalogs can contain products that are no longer present in the selected
      // marketplace. Keep the current summary and the other offer snapshots.
      // This is an expected per-ASIN condition, not a failed sync.
      if (/requested item[\s\S]*(not found|does not exist)|not found in marketplace/i.test(message)) continue;
      failures.push(`${asin}: ${message}`);
    }
  }
  if (failures.length) throw new Error(`Failed pricing offers: ${failures.join("; ")}`);
  return publishedOffers + 1;
}
