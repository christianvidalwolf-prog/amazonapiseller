/**
 * Builds the profit-first campaign plan per country (spec advertising §10) from FBA stock, catalog
 * families, per-country margins, Buy Box and the stored Ads reports. Read-only: saves the plan to
 * `ads:plan:<profileId>` (Supabase or backend/data/ads-reports) and a markdown for review.
 * Nothing is created in Amazon here — see ads:apply-plan.
 *
 *   npm run ads:plan                                # ES, DE, FR, IT
 *   ADS_PLAN_COUNTRIES=ES ADS_PLAN_BUDGET_ES=15 npm run ads:plan
 *   ADS_STORE=file npm run ads:plan                 # keep the plan in backend/data only
 *   ADS_PLAN_REUSE=1 ADS_PLAN_BUDGET_ES=20 npm run ads:plan   # rebuild from the cached inputs in seconds
 */
import fs from "node:fs";
import path from "node:path";
import { AdsApiClient } from "../src/ads/adsClient";
import type { AdvertisedProductReportRow, SearchTermReportRow } from "../src/ads/reportTypes";
import type { AdsProfile } from "../src/ads/types";
import { env } from "../src/config/env";
import { buildSkuContext } from "../src/modules/advertising/adContext";
import { isFbaSku, spApiContextSources } from "../src/modules/advertising/adContext.sync";
import { VAT_BY_COUNTRY } from "../src/modules/advertising/adMargins";
import { salesChannelFor } from "../src/modules/advertising/advertising.metrics";
import { type AdsReportStore, adsPlanKey, createFileAdsReportStore, createSupabaseAdsReportStore } from "../src/modules/advertising/adsReports.store";
import { buildCampaignPlan, type PlanCandidate, type PlanInput } from "../src/modules/advertising/campaignPlan";
import { autoTargetingMultipliers, convertingTermSeeds } from "../src/modules/advertising/campaignPlan.inputs";
import { renderCampaignPlan } from "../src/modules/advertising/campaignPlan.render";
import { unitProfitBeforeAds } from "../src/modules/advertising/profitability";
import { PricingService } from "../src/modules/pricing/pricing.service";
import { SalesService } from "../src/modules/sales/sales.service";
import { SpApiClient } from "../src/spapi/client";
import { getCatalogItem } from "../src/spapi/endpoints/catalogItems";
import { getInventorySummaries } from "../src/spapi/endpoints/fbaInventory";
import { loadStockSnapshot } from "./lib/listing-archive-store";
import { AdvertisingService } from "../src/modules/advertising/advertising.service";

const COUNTRIES = (process.env.ADS_PLAN_COUNTRIES ?? "ES,DE,FR,IT").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
const PREFIX = process.env.ADS_PLAN_PREFIX ?? "PF";
const BRANDS = (process.env.ADS_BRANDS ?? "Rocking Gifts").split(",").map((b) => b.trim()).filter(Boolean);
const BUDGET_SHARE_OF_SPEND = 0.7;
const MIN_COUNTRY_BUDGET = 5;
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isoDaysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

async function stockedFba(sp: SpApiClient, marketplaceId: string): Promise<Map<string, { asin: string; fulfillable: number }>> {
  const out = new Map<string, { asin: string; fulfillable: number }>();
  let nextToken: string | undefined;
  do {
    const res = await getInventorySummaries(sp, { marketplaceIds: [marketplaceId], nextToken });
    for (const s of res.payload?.inventorySummaries ?? []) {
      const q = s.inventoryDetails?.fulfillableQuantity ?? 0;
      if (q > 0 && isFbaSku(s.sellerSku)) out.set(s.sellerSku, { asin: s.asin, fulfillable: q });
    }
    nextToken = res.pagination?.nextToken;
  } while (nextToken);
  return out;
}

/** Family (Amazon display group, in Spanish) and brand of each ASIN, from the ES catalog. */
async function families(sp: SpApiClient, asins: string[]): Promise<Map<string, { family: string; brand: string | null }>> {
  const out = new Map<string, { family: string; brand: string | null }>();
  for (const asin of asins) {
    try {
      const item = await getCatalogItem(sp, { asin, marketplaceIds: [env.marketplaceIds[0]] });
      const summary = item.summaries?.[0];
      const family = item.salesRanks?.[0]?.displayGroupRanks?.[0]?.title ?? summary?.browseClassification?.displayName ?? "Varios";
      out.set(asin, { family, brand: summary?.brand ?? null });
    } catch {
      out.set(asin, { family: "Varios", brand: null });
    }
  }
  return out;
}

async function planCountry(
  profile: AdsProfile,
  ads: AdsApiClient,
  store: AdsReportStore,
  stock: Map<string, { asin: string; fulfillable: number }>,
  catalog: Map<string, { family: string; brand: string | null }>,
  units: { u30: Record<string, Record<string, { units: number; returnedUnits: number }>>; u90: Record<string, Record<string, { units: number; returnedUnits: number }>> }
) {
  const cc = profile.countryCode;
  const profileId = String(profile.profileId);
  const marketplaceId = profile.accountInfo.marketplaceStringId;
  const sp = new SpApiClient({ credentials: env.spApi });
  const pricing = new PricingService(sp, marketplaceId, env.sellerId);
  const sources = spApiContextSources(sp, marketplaceId, env.sellerId);
  const channel = salesChannelFor(cc) ?? "";
  const [products, terms] = await Promise.all([
    store.load<AdvertisedProductReportRow>(profileId, "advertisedProducts"),
    store.load<SearchTermReportRow>(profileId, "searchTerms"),
  ]);
  const rows = products?.rows ?? [];
  const history = new Map<string, { clicks: number; sameSkuSales: number }>();
  for (const r of rows) {
    const h = history.get(r.advertisedSku ?? "") ?? { clicks: 0, sameSkuSales: 0 };
    history.set(r.advertisedSku ?? "", { clicks: h.clicks + num(r.clicks), sameSkuSales: h.sameSkuSales + num(r.attributedSalesSameSku7d) });
  }
  const clicks = rows.reduce((a, r) => a + num(r.clicks), 0);
  const accountCvr = clicks > 0 ? rows.reduce((a, r) => a + num(r.purchases7d), 0) / clicks : 0.02;
  const spend30 = rows.reduce((a, r) => a + num(r.cost), 0);

  const candidates: PlanCandidate[] = [];
  const margins = [];
  for (const [sku, { asin, fulfillable }] of stock) {
    let price: number | null = null;
    let feesTotal: number | null = null;
    let landedCost: number | null = null;
    try {
      const m = await pricing.getUnitMargin(sku, { fulfilled: "amazon" });
      price = m.price;
      feesTotal = m.fees.total;
      landedCost = m.landedCost;
    } catch {
      // No offer in this marketplace: excluded below.
    }
    const buyBox = price === null ? null : await sources.buyBox(asin).catch(() => null);
    const ctx = buildSkuContext({
      sku,
      asin,
      fulfillable,
      units30: units.u30[channel]?.[sku]?.units ?? 0,
      units90: units.u90[channel]?.[sku]?.units ?? 0,
      returned90: units.u90[channel]?.[sku]?.returnedUnits ?? 0,
      buyBox,
    });
    const margin = { sku, price, feesTotal, landedCost, vatRate: VAT_BY_COUNTRY[cc] ?? null };
    margins.push(margin);
    const raw = unitProfitBeforeAds(margin);
    const unitProfit = raw === null ? null : Math.round(raw * (1 - (ctx.returnRate ?? 0)) * 100) / 100;
    candidates.push({
      sku,
      asin,
      family: catalog.get(asin)?.family ?? "Varios",
      brand: catalog.get(asin)?.brand ?? null,
      price,
      unitProfit,
      breakEvenAcos: unitProfit !== null && price ? Math.round((Math.max(0, unitProfit) / price) * 10_000) / 100 : null,
      alpha: ctx.alpha,
      flags: ctx.flags,
      clicks: history.get(sku)?.clicks ?? 0,
      sameSkuSales: history.get(sku)?.sameSkuSales ?? 0,
      // Own units and spend are filled from the report on every run (enrichInput).
      sameSkuUnits: 0,
      spend: 0,
    });
  }

  const enabled = (await ads.listSponsoredProductsCampaigns(profileId)).filter((c) => c.state === "enabled" && !c.name.startsWith(`${PREFIX} |`));
  const input: PlanInput = {
    country: cc,
    prefix: PREFIX,
    dailyBudget: Math.max(MIN_COUNTRY_BUDGET, Math.round((spend30 / 30) * BUDGET_SHARE_OF_SPEND * 100) / 100),
    accountCvr,
    candidates,
    terms: terms && products ? convertingTermSeeds(terms.rows, rows, margins) : [],
    autoMultipliers: terms ? autoTargetingMultipliers(terms.rows) : {},
    brandNames: BRANDS,
    oldEnabledCampaigns: enabled.map((c) => ({ campaignId: c.campaignId, name: c.name })),
  };
  await store.writeSnapshot(planInputKey(profileId), input);
  return input;
}

const planInputKey = (profileId: string) => `ads:plan-input:${profileId}`;

type FbmStock = Map<string, number>;

/**
 * Brings each candidate's ad history up to date (clicks, spend, own units and sales) and adds the FBM
 * SKUs that the profitability bridge proves profitable in this country and that have stock in our
 * warehouse (STOCK AMZ). FBM enters only as proven winners: its margin has no FBA fee to anchor it.
 */
async function enrichInput(store: AdsReportStore, profile: AdsProfile, input: PlanInput, fbmStock: FbmStock, sp: SpApiClient): Promise<PlanInput> {
  const profileId = String(profile.profileId);
  const rows = (await store.load<AdvertisedProductReportRow>(profileId, "advertisedProducts"))?.rows ?? [];
  const history = new Map<string, { clicks: number; sameSkuSales: number; sameSkuUnits: number; spend: number }>();
  for (const r of rows) {
    const h = history.get(r.advertisedSku ?? "") ?? { clicks: 0, sameSkuSales: 0, sameSkuUnits: 0, spend: 0 };
    history.set(r.advertisedSku ?? "", {
      clicks: h.clicks + num(r.clicks),
      sameSkuSales: h.sameSkuSales + num(r.attributedSalesSameSku7d),
      sameSkuUnits: h.sameSkuUnits + num(r.unitsSoldSameSku7d),
      spend: h.spend + num(r.cost),
    });
  }
  const none = { clicks: 0, sameSkuSales: 0, sameSkuUnits: 0, spend: 0 };
  const candidates: PlanCandidate[] = input.candidates.map((c) => ({ ...c, ...(history.get(c.sku) ?? none), fulfillment: "FBA" }));

  const bridge = await new AdvertisingService(new AdsApiClient(env.adsApi), env.marketplaceIds[0], undefined, { reports: store }).getProfitability(profile.countryCode);
  const known = new Set(candidates.map((c) => c.sku));
  for (const s of bridge.skus) {
    if (s.verdict !== "profitable" || isFbaSku(s.sku) || known.has(s.sku) || !s.asin || (fbmStock.get(s.sku) ?? 0) <= 0) continue;
    const meta = (await families(sp, [s.asin])).get(s.asin);
    candidates.push({
      sku: s.sku,
      asin: s.asin,
      family: meta?.family ?? "Varios",
      brand: meta?.brand ?? null,
      price: s.price,
      unitProfit: s.unitProfitBeforeAds,
      breakEvenAcos: s.breakEvenAcos,
      alpha: s.alpha,
      flags: s.flags,
      ...(history.get(s.sku) ?? none),
      fulfillment: "FBM",
    });
  }
  return { ...input, candidates };
}

/** Builds and stores the plan; the budget, prefix and brands of this run override the cached inputs. */
async function savePlan(store: AdsReportStore, profileId: string, input: PlanInput) {
  const override = Number(process.env[`ADS_PLAN_BUDGET_${input.country}`]);
  const plan = buildCampaignPlan({
    ...input,
    prefix: PREFIX,
    brandNames: BRANDS,
    dailyBudget: Number.isFinite(override) && override > 0 ? override : input.dailyBudget,
  });
  await store.writeSnapshot(adsPlanKey(profileId), { ...plan, profileId, generatedAt: new Date().toISOString() });
  return plan;
}

async function main(): Promise<void> {
  const ads = new AdsApiClient(env.adsApi);
  // ADS_STORE=file keeps the plan local (Supabase is still read for Sellerboard costs).
  const store =
    process.env.ADS_STORE !== "file" && env.supabase.url && env.supabase.serviceRoleKey
      ? createSupabaseAdsReportStore(env.supabase.url, env.supabase.serviceRoleKey)
      : createFileAdsReportStore(path.resolve(process.cwd(), "data/ads-reports"));
  const sp = new SpApiClient({ credentials: env.spApi });
  const profiles = (await ads.getProfiles()).filter((p) => COUNTRIES.includes(p.countryCode));
  const sections = [`# Plan de campañas profit-first · ${new Date().toISOString().slice(0, 10)}`, "_Nada creado en Amazon. Revisar y aprobar; se crea EN PAUSA con `npm run ads:apply-plan`._"];
  const stockAmz = await loadStockSnapshot();
  const fbmStock: FbmStock = new Map((stockAmz?.items ?? []).map((i) => [String(i.sku), Number(i.quantity) || 0]));
  console.log(`STOCK AMZ: ${stockAmz ? `${fbmStock.size} SKUs (${stockAmz.updatedAt})` : "sin copia: no entran FBM"}`);
  const finish = async (p: AdsProfile, input: PlanInput, label: string) => {
    const plan = await savePlan(store, String(p.profileId), await enrichInput(store, p, input, fbmStock, sp));
    sections.push(renderCampaignPlan(plan));
    const fbm = plan.campaigns.flatMap((c) => c.adGroups.flatMap((g) => g.skus)).filter((sku) => !isFbaSku(sku));
    console.log(`ok   ${p.countryCode}: ${plan.campaigns.length} campañas, ${plan.excluded.length} SKUs excluidos, ${new Set(fbm).size} FBM${label}`);
  };
  if (process.env.ADS_PLAN_REUSE === "1") {
    for (const p of profiles) {
      const input = await store.readSnapshot<PlanInput>(planInputKey(String(p.profileId)));
      if (!input) throw new Error(`${p.countryCode}: no hay entradas en caché; ejecuta npm run ads:plan sin ADS_PLAN_REUSE`);
      await finish(p, input, " (caché)");
    }
    writeMarkdown(sections);
    return;
  }
  // Pan-European FBA: the sellable pool is read once in the first country's marketplace.
  const stock = await stockedFba(sp, profiles[0].accountInfo.marketplaceStringId);
  console.log(`SKUs FBA con stock: ${stock.size}`);
  const catalog = await families(sp, [...new Set([...stock.values()].map((s) => s.asin))]);
  const sales = new SalesService(sp, env.marketplaceIds);
  const now = new Date().toISOString();
  const units = { u30: await sales.getSkuUnitsByChannel(isoDaysAgo(30), now), u90: await sales.getSkuUnitsByChannel(isoDaysAgo(90), now) };

  for (const p of profiles) await finish(p, await planCountry(p, ads, store, stock, catalog, units), "");
  writeMarkdown(sections);
}

function writeMarkdown(sections: string[]): void {
  const file = path.resolve(process.cwd(), `data/ads-plan-${new Date().toISOString().slice(0, 10)}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, sections.join("\n\n"));
  console.log(`Plan guardado en ${file}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
