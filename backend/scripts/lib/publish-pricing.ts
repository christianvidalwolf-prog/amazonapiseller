import type { PricingDashboardSummary } from "../../src/modules/pricing/pricing.service";

export async function publishPricingSnapshots(
  readPayload: (path: string) => Promise<unknown>,
  writeSnapshot: (key: string, data: unknown) => Promise<void>
): Promise<number> {
  // 0 means the complete catalog. The pricing screen's default is "all"
  // products, so the published production snapshot must not truncate it.
  const summary = await readPayload("/api/pricing/summary?limit=0&force=true") as PricingDashboardSummary;
  if (!summary || !Array.isArray(summary.products)) throw new Error("Invalid pricing summary");
  await writeSnapshot("pricing:summary", summary);
  // Las ofertas se consultan bajo demanda desde Render cuando el usuario
  // abre un ASIN. No hacemos una llamada por producto durante la Action:
  // Amazon puede devolver 500/rate-limit y bloquear toda la sincronización.
  return 1;
}
