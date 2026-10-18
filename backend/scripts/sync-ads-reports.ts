/**
 * Proceso 1 — downloads the Sponsored Products performance reports (campaigns,
 * advertised products, search terms) of the Ads profile for the last complete
 * 30-day window (ends 3 days ago) and stores them in Supabase snapshots
 * (`ads:report:<kind>:<profileId>`), or backend/data/ads-reports without Supabase.
 *
 *   npm run ads:sync-reports            # profile from ADS_API_PROFILE_ID
 *   ADS_SYNC_MAX_WAIT_MIN=45 npm run ads:sync-reports
 *
 * Then builds the unit margin of every advertised SKU (`ads:margins:<profileId>`)
 * for the profitability bridge — FBM and out-of-stock SKUs included.
 *
 * Read-only against Amazon. Exits non-zero if any report could not be stored
 * (the previous copy of that report stays).
 */
import path from "node:path";
import { AdsApiClient } from "../src/ads/adsClient";
import { env } from "../src/config/env";
import type { AdvertisedProductReportRow } from "../src/ads/reportTypes";
import { buildAdMargins } from "../src/modules/advertising/adMargins";
import { adsMarginsKey, createFileAdsReportStore, createSupabaseAdsReportStore } from "../src/modules/advertising/adsReports.store";
import { PricingService } from "../src/modules/pricing/pricing.service";
import { SpApiClient } from "../src/spapi/client";
import { syncAdsReports } from "../src/modules/advertising/adsReports.sync";
import { AdvertisingService } from "../src/modules/advertising/advertising.service";

async function main(): Promise<void> {
  const client = new AdsApiClient(env.adsApi);
  const status = await new AdvertisingService(client, env.marketplaceIds[0], env.adsApi.profileId || undefined).getConnectionStatus();
  if (!status.isConnected || !status.profileId) {
    throw new Error(`Amazon Ads no conectado (${status.error?.kind}): ${status.error?.message}`);
  }
  const store =
    env.supabase.url && env.supabase.serviceRoleKey
      ? createSupabaseAdsReportStore(env.supabase.url, env.supabase.serviceRoleKey)
      : createFileAdsReportStore(path.resolve(process.cwd(), "data/ads-reports"));
  const maxWaitMs = Number(process.env.ADS_SYNC_MAX_WAIT_MIN ?? 30) * 60_000;

  console.log(`Ads reports · perfil ${status.profileId} (${status.profile?.countryCode})`);
  const results = await syncAdsReports(client, store, status.profileId, { maxWaitMs });
  for (const r of results) {
    console.log(`${r.status === "saved" ? "ok  " : "FAIL"} ${r.kind}${r.rows !== undefined ? ` (${r.rows} filas)` : ""}${r.error ? `: ${r.error}` : ""}`);
  }
  console.log(`reintentos HTTP: ${client.retries}`);

  const products = await store.load<AdvertisedProductReportRow>(status.profileId, "advertisedProducts");
  if (products) {
    const pricing = new PricingService(new SpApiClient({ credentials: env.spApi }), env.marketplaceIds[0], env.sellerId);
    const margins = await buildAdMargins(products.rows, (sku) => pricing.getUnitMargin(sku));
    await store.writeSnapshot(adsMarginsKey(status.profileId), margins);
    const complete = margins.items.filter((m) => m.price !== null && m.feesTotal !== null && m.landedCost !== null).length;
    console.log(`ok   márgenes de SKUs anunciados (${complete}/${margins.items.length} completos)`);
  }
  if (results.some((r) => r.status !== "saved")) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
