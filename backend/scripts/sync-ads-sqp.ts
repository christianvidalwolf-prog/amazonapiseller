import path from "node:path";
import { AdsApiClient } from "../src/ads/adsClient";
import type { AdvertisedProductReportRow } from "../src/ads/reportTypes";
import { env } from "../src/config/env";
import { createFileAdsReportStore } from "../src/modules/advertising/adsReports.store";
import { SpApiClient } from "../src/spapi/client";
import { SearchFunnelService } from "../src/modules/brand-analytics/searchFunnel.service";
import { createSupabaseSearchQueryMetricsRepository } from "../src/modules/brand-analytics/searchFunnel.supabaseRepository";

const marketplaces = [
  { country: "ES", marketplaceId: "A1RKKUPIHCS9HS", asins: ["B07TFBJCZF", "B0CW6M5LDL", "B09X21YQH3", "B0CL3BJQRG", "B0F1TYC1BW", "B09X8RCLHW", "B0F226QZ2Z"] },
  { country: "DE", marketplaceId: "A1PA6795UKMFR9", asins: ["B0BW9R6LFR", "B0CPK8M38Q"] },
  { country: "FR", marketplaceId: "A13V1IB3VIYZZH", asins: ["B07THDFDM8"] },
  { country: "IT", marketplaceId: "APJ6JRA9NG5V4", asins: ["B09X21YQH3", "B07THDFDM8"] },
];

/** SQP covers the pilot ASINs plus the advertised ASINs with most sales, then spend (Fase C). */
const MAX_ASINS = 36;
async function advertisedAsins(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    const ads = new AdsApiClient(env.adsApi);
    const store = createFileAdsReportStore(path.resolve(process.cwd(), "data", "ads-reports"));
    for (const p of await ads.getProfiles()) {
      const rows = (await store.load<AdvertisedProductReportRow>(String(p.profileId), "advertisedProducts"))?.rows ?? [];
      const score = new Map<string, { sales: number; spend: number }>();
      for (const r of rows) {
        const asin = String(r.advertisedAsin ?? "").toUpperCase();
        if (!/^B0[A-Z0-9]{8}$/.test(asin)) continue;
        const s = score.get(asin) ?? { sales: 0, spend: 0 };
        score.set(asin, { sales: s.sales + Number(r.sales7d ?? 0), spend: s.spend + Number(r.cost ?? 0) });
      }
      out.set(p.countryCode, [...score].sort((a, b) => b[1].sales - a[1].sales || b[1].spend - a[1].spend).map(([asin]) => asin));
    }
  } catch (err) {
    console.log(`aviso: sin ASINs anunciados (${err instanceof Error ? err.message : err}); solo los del piloto`);
  }
  return out;
}

async function main(): Promise<void> {
  if (!env.supabase.url || !env.supabase.serviceRoleKey) throw new Error("La sincronización SQP requiere el repositorio Supabase configurado");
  const client = new SpApiClient({ credentials: env.spApi });
  const repository = createSupabaseSearchQueryMetricsRepository(env.supabase.url, env.supabase.serviceRoleKey);
  const selectedCountry = process.env.ADS_SQP_SYNC_COUNTRY?.trim().toUpperCase();
  const selectedMarkets = selectedCountry ? marketplaces.filter((market) => market.country === selectedCountry) : marketplaces;
  if (selectedCountry && !selectedMarkets.length) throw new Error(`País SQP no reconocido: ${selectedCountry}`);
  const advertised = await advertisedAsins();
  for (const market of selectedMarkets) {
    const asins = [...new Set([...market.asins, ...(advertised.get(market.country) ?? [])])].slice(0, MAX_ASINS);
    const service = new SearchFunnelService(client, {
      marketplaceId: market.marketplaceId,
      asins,
      brand: "",
      maxAsins: MAX_ASINS,
      maxReports: 3,
    }, repository);
    const status = await service.sync({ period: "WEEK", marketplaceId: market.marketplaceId });
    console.log(`${market.country}: SQP ${asins.length} ASINs · ${status.state}, ${status.rows} filas, ${status.requestedReports} informes${status.errors.length ? ` · ${status.errors.join("; ")}` : ""}`);
    if (status.state === "failed" || status.errors.length) process.exitCode = 1;
  }
}

main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; });
