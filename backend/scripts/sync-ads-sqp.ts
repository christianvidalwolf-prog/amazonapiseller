import { env } from "../src/config/env";
import { SpApiClient } from "../src/spapi/client";
import { SearchFunnelService } from "../src/modules/brand-analytics/searchFunnel.service";
import { createSupabaseSearchQueryMetricsRepository } from "../src/modules/brand-analytics/searchFunnel.supabaseRepository";

const marketplaces = [
  { country: "ES", marketplaceId: "A1RKKUPIHCS9HS", asins: ["B07TFBJCZF", "B0CW6M5LDL", "B09X21YQH3", "B0CL3BJQRG", "B0F1TYC1BW", "B09X8RCLHW", "B0F226QZ2Z"] },
  { country: "DE", marketplaceId: "A1PA6795UKMFR9", asins: ["B0BW9R6LFR", "B0CPK8M38Q"] },
  { country: "FR", marketplaceId: "A13V1IB3VIYZZH", asins: ["B07THDFDM8"] },
  { country: "IT", marketplaceId: "APJ6JRA9NG5V4", asins: ["B09X21YQH3", "B07THDFDM8"] },
];

async function main(): Promise<void> {
  if (!env.supabase.url || !env.supabase.serviceRoleKey) throw new Error("La sincronización SQP requiere el repositorio Supabase configurado");
  const client = new SpApiClient({ credentials: env.spApi });
  const repository = createSupabaseSearchQueryMetricsRepository(env.supabase.url, env.supabase.serviceRoleKey);
  const selectedCountry = process.env.ADS_SQP_SYNC_COUNTRY?.trim().toUpperCase();
  const selectedMarkets = selectedCountry ? marketplaces.filter((market) => market.country === selectedCountry) : marketplaces;
  if (selectedCountry && !selectedMarkets.length) throw new Error(`País SQP no reconocido: ${selectedCountry}`);
  for (const market of selectedMarkets) {
    const service = new SearchFunnelService(client, {
      marketplaceId: market.marketplaceId,
      asins: market.asins,
      brand: "",
      maxAsins: 36,
      maxReports: 2,
    }, repository);
    const status = await service.sync({ period: "WEEK", marketplaceId: market.marketplaceId });
    console.log(`${market.country}: SQP ${status.state}, ${status.rows} filas, ${status.requestedReports} informes${status.errors.length ? ` · ${status.errors.join("; ")}` : ""}`);
    if (status.state === "failed" || status.errors.length) process.exitCode = 1;
  }
}

main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; });
