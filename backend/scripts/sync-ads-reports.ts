/**
 * Procesos 1-2 — downloads the Sponsored Products performance reports (campaigns,
 * advertised products, search terms) of each country's Ads profile for the last
 * complete 30-day window (ends 3 days ago) and stores them in Supabase snapshots
 * (`ads:report:<kind>:<profileId>`), or backend/data/ads-reports without Supabase.
 * Then builds the unit margin of every advertised SKU with that marketplace's
 * price, fees and VAT (`ads:margins:<profileId>`).
 *
 *   npm run ads:sync-reports                          # ES, DE, FR, IT
 *   ADS_SYNC_COUNTRIES=ES npm run ads:sync-reports
 *   ADS_SYNC_MAX_WAIT_MIN=45 npm run ads:sync-reports
 *
 * Read-only against Amazon. Exits non-zero if any report could not be stored
 * (the previous copy of that report stays).
 */
import path from "node:path";
import { AdsApiClient } from "../src/ads/adsClient";
import type { AdvertisedProductReportRow } from "../src/ads/reportTypes";
import type { AdsProfile } from "../src/ads/types";
import { env } from "../src/config/env";
import { buildAdMargins, VAT_BY_COUNTRY } from "../src/modules/advertising/adMargins";
import { type AdsReportStore, adsMarginsKey, createFileAdsReportStore, createSupabaseAdsReportStore } from "../src/modules/advertising/adsReports.store";
import { syncAdsReports } from "../src/modules/advertising/adsReports.sync";
import { PricingService } from "../src/modules/pricing/pricing.service";
import { SpApiClient } from "../src/spapi/client";

const COUNTRIES = (process.env.ADS_SYNC_COUNTRIES ?? "ES,DE,FR,IT").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);

async function syncReports(client: AdsApiClient, store: AdsReportStore, profile: AdsProfile, maxWaitMs: number): Promise<boolean> {
  const results = await syncAdsReports(client, store, String(profile.profileId), { maxWaitMs });
  for (const r of results) {
    console.log(`${r.status === "saved" ? "ok  " : "FAIL"} ${profile.countryCode} ${r.kind}${r.rows !== undefined ? ` (${r.rows} filas)` : ""}${r.error ? `: ${r.error}` : ""}`);
  }
  return results.every((r) => r.status === "saved");
}

/** Unit margin of every advertised SKU with this marketplace's price, fees and VAT. */
async function syncMargins(store: AdsReportStore, profile: AdsProfile): Promise<void> {
  const profileId = String(profile.profileId);
  const products = await store.load<AdvertisedProductReportRow>(profileId, "advertisedProducts");
  if (!products) return;
  const pricing = new PricingService(new SpApiClient({ credentials: env.spApi }), profile.accountInfo.marketplaceStringId, env.sellerId);
  const margins = await buildAdMargins(products.rows, (sku) => pricing.getUnitMargin(sku), new Date(), VAT_BY_COUNTRY[profile.countryCode]);
  await store.writeSnapshot(adsMarginsKey(profileId), margins);
  const complete = margins.items.filter((m) => m.price !== null && m.feesTotal !== null && m.landedCost !== null).length;
  console.log(`ok   ${profile.countryCode} márgenes de SKUs anunciados (${complete}/${margins.items.length} completos)`);
}

async function main(): Promise<void> {
  const client = new AdsApiClient(env.adsApi);
  if (!client.isConfigured()) throw new Error("Amazon Ads no configurado (ADS_API_CLIENT_ID / ADS_API_CLIENT_SECRET / ADS_API_REFRESH_TOKEN)");
  const profiles = (await client.getProfiles()).filter((p) => COUNTRIES.includes(p.countryCode));
  const missing = COUNTRIES.filter((c) => !profiles.some((p) => p.countryCode === c));
  if (missing.length) console.warn(`Sin perfil de Amazon Ads autorizado para: ${missing.join(", ")}`);

  const store =
    env.supabase.url && env.supabase.serviceRoleKey
      ? createSupabaseAdsReportStore(env.supabase.url, env.supabase.serviceRoleKey)
      : createFileAdsReportStore(path.resolve(process.cwd(), "data/ads-reports"));
  const maxWaitMs = Number(process.env.ADS_SYNC_MAX_WAIT_MIN ?? 30) * 60_000;

  console.log(`Ads reports · ${profiles.map((p) => `${p.countryCode} ${p.profileId}`).join(" · ")}`);
  // Amazon builds the reports of every profile in parallel; margins then run one country at a time
  // so the SP-API calls (pricing, listings, fees) share the per-seller rate limits.
  const ok = await Promise.all(profiles.map((p) => syncReports(client, store, p, maxWaitMs)));
  for (const p of profiles) await syncMargins(store, p);
  console.log(`reintentos HTTP: ${client.retries}`);
  if (missing.length || ok.includes(false)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
