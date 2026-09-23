import type { PricingDashboardSummary } from "../../src/modules/pricing/pricing.service";

export async function publishPricingSnapshots(
  readPayload: (path: string) => Promise<unknown>,
  writeSnapshot: (key: string, data: unknown) => Promise<void>
): Promise<number> {
  const summary = await readPayload("/api/pricing/summary?limit=40&force=true") as PricingDashboardSummary;
  if (!summary || !Array.isArray(summary.products)) throw new Error("Invalid pricing summary");
  await writeSnapshot("pricing:summary", summary);
  const failures: string[] = [];
  const asins = new Set(summary.products.map((product) => product.asin));
  for (const asin of asins) {
    try {
      const detail = await readPayload(`/api/pricing/offers?asin=${encodeURIComponent(asin)}`);
      await writeSnapshot(`pricing:offers:${asin}`, detail);
    } catch (error) {
      failures.push(`${asin}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) throw new Error(`Failed pricing offers: ${failures.join("; ")}`);
  return asins.size + 1;
}
