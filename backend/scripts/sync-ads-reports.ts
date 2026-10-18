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
 *   ADS_SYNC_STEPS=margins,context npm run ads:sync-reports   # reuse the stored reports
 *
 * Steps: reports (Ads Reporting v3), margins (`ads:margins:<profileId>`) and context
 * (`ads:context:<profileId>`: FBA stock, Buy Box, sales velocity and return rate — the
 * circuit breakers of spec §9).
 *
 * Read-only against Amazon. Exits non-zero if any report could not be stored
 * (the previous copy of that report stays).
 */
import path from "node:path";
import { AdsApiClient } from "../src/ads/adsClient";
import type { AdvertisedProductReportRow } from "../src/ads/reportTypes";
import type { AdsProfile } from "../src/ads/types";
import { env } from "../src/config/env";
import { collectAdContext, spApiContextSources } from "../src/modules/advertising/adContext.sync";
import { buildAdMargins, VAT_BY_COUNTRY } from "../src/modules/advertising/adMargins";
import { salesChannelFor } from "../src/modules/advertising/advertising.metrics";
import { type AdsReportStore, adsContextKey, adsMarginsKey, createFileAdsReportStore, createSupabaseAdsReportStore } from "../src/modules/advertising/adsReports.store";
import { syncAdsReports } from "../src/modules/advertising/adsReports.sync";
import { PricingService } from "../src/modules/pricing/pricing.service";
import { SalesService } from "../src/modules/sales/sales.service";
import { SpApiClient } from "../src/spapi/client";

const COUNTRIES = (process.env.ADS_SYNC_COUNTRIES ?? "ES,DE,FR,IT").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
const STEPS = new Set((process.env.ADS_SYNC_STEPS ?? "reports,margins,context").split(",").map((s) => s.trim()));
type UnitsByChannel = Awaited<ReturnType<SalesService["getSkuUnitsByChannel"]>>;
const isoDaysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

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

/** Stock cover, Buy Box and return rate of every advertised SKU in this marketplace. */
async function syncContext(store: AdsReportStore, profile: AdsProfile, units30: UnitsByChannel, units90: UnitsByChannel): Promise<void> {
  const profileId = String(profile.profileId);
  const products = await store.load<AdvertisedProductReportRow>(profileId, "advertisedProducts");
  if (!products) return;
  const channel = salesChannelFor(profile.countryCode) ?? "";
  const sp = spApiContextSources(new SpApiClient({ credentials: env.spApi }), profile.accountInfo.marketplaceStringId, env.sellerId);
  const { snapshot, buyBoxErrors } = await collectAdContext(products.rows, { ...sp, units30: units30[channel] ?? {}, units90: units90[channel] ?? {} });
  await store.writeSnapshot(adsContextKey(profileId), snapshot);
  const flagged = snapshot.items.filter((i) => i.flags.some((f) => f !== "STOCK_NO_VERIFICADO")).length;
  console.log(`ok   ${profile.countryCode} contexto stock/Buy Box (${snapshot.items.length} SKUs, ${flagged} con alerta, ${buyBoxErrors} Buy Box sin respuesta)`);
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
  const ok = STEPS.has("reports") ? await Promise.all(profiles.map((p) => syncReports(client, store, p, maxWaitMs))) : [];
  if (STEPS.has("margins")) for (const p of profiles) await syncMargins(store, p);
  if (STEPS.has("context")) {
    const sales = new SalesService(new SpApiClient({ credentials: env.spApi }), env.marketplaceIds);
    const now = new Date().toISOString();
    const [units30, units90] = [await sales.getSkuUnitsByChannel(isoDaysAgo(30), now), await sales.getSkuUnitsByChannel(isoDaysAgo(90), now)];
    for (const p of profiles) await syncContext(store, p, units30, units90);
  }
  console.log(`reintentos HTTP: ${client.retries}`);
  if (missing.length || ok.includes(false)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
