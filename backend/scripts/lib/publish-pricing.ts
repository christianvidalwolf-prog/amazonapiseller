import type { PricingDashboardSummary } from "../../src/modules/pricing/pricing.service";

export async function publishPricingSnapshots(
  readPayload: (path: string) => Promise<unknown>,
  writeSnapshot: (key: string, data: unknown) => Promise<void>
): Promise<number> {
  // 0 means the complete catalog. The pricing screen's default is "all"
  // products, so the published production snapshot tries to load all items.
  // If Amazon throttles or drops connections on limit=0, fallback to limit=200.
  let summary: PricingDashboardSummary | null = null;
  try {
    summary = (await readPayload("/api/pricing/summary?limit=0&force=true")) as PricingDashboardSummary;
  } catch (firstErr) {
    console.warn("Fallo al obtener pricing con limit=0, reintentando con fallback limit=200:", firstErr instanceof Error ? firstErr.message : String(firstErr));
    try {
      summary = (await readPayload("/api/pricing/summary?limit=200&force=true")) as PricingDashboardSummary;
    } catch (secondErr) {
      throw new Error(`Pricing fetch falló en ambos intentos: ${secondErr instanceof Error ? secondErr.message : String(secondErr)}`);
    }
  }

  if (!summary || !Array.isArray(summary.products)) throw new Error("Invalid pricing summary payload");
  await writeSnapshot("pricing:summary", summary);
  // Las ofertas se consultan bajo demanda desde Render cuando el usuario
  // abre un ASIN. No hacemos una llamada por producto durante la Action:
  // Amazon puede devolver 500/rate-limit y bloquear toda la sincronización.
  return 1;
}
