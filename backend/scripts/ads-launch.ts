/**
 * Launches one product family in Sponsored Products from a keyword seed (spec advertising §13):
 * four campaigns `SP-<family>-{Auto,Exact,Phrase,Marca}`, one ad group each with every SKU of the family.
 *
 *   npm run ads:launch                                         # dry run of ads/keywords/40973_keywords.json
 *   npm run ads:launch -- ads/keywords/40973_keywords.json     # another seed
 *   ADS_APPLY=1 npm run ads:launch                             # creates the campaigns PAUSED (seed must be "approved")
 *   ADS_MODE=activate ADS_APPLY=1 npm run ads:launch           # enables them (FBA ad only with FBA + inbound ≥ minFbaUnits)
 *   ADS_MODE=rollback ADS_APPLY=1 npm run ads:launch           # pauses them again
 *
 * Idempotent by name. Bids that already exist in Amazon are never changed here. Every applied write
 * is recorded in the Change Log (`ads:changelog:<profileId>`) with a review date 14 days ahead.
 */
import fs from "node:fs";
import path from "node:path";
import { AdsApiClient } from "../src/ads/adsClient";
import { env } from "../src/config/env";
import { type AdsReportStore, createFileAdsReportStore, createSupabaseAdsReportStore } from "../src/modules/advertising/adsReports.store";
import { salesChannelFor } from "../src/modules/advertising/advertising.metrics";
import { type AdsWriter, type ApplyLogEntry, CampaignPlanApplier } from "../src/modules/advertising/campaignApply";
import type { CampaignPlan } from "../src/modules/advertising/campaignPlan";
import { addDays, appendEntry, type ChangeLogEntry, changelogKey, REVIEW_AFTER_DAYS } from "../src/modules/advertising/changelog";
import { buildLaunchPlan, type FbaUnits, fbaReady, type LaunchSeed, parseLaunchSeed, tacosBudgetCap, targetCpc, validateLaunchSeed } from "../src/modules/advertising/launchPlan";
import { SalesService } from "../src/modules/sales/sales.service";
import { SpApiClient } from "../src/spapi/client";
import { getInventorySummaries } from "../src/spapi/endpoints/fbaInventory";

const SEED = process.argv[2] ?? process.env.ADS_LAUNCH_SEED ?? "ads/keywords/40973_keywords.json";
const APPLY = process.env.ADS_APPLY === "1";
const MODE = (process.env.ADS_MODE ?? "create") as "create" | "activate" | "rollback";
const MT_PRODUCT_AD = "application/vnd.spProductAd.v3+json";
const MT_CAMPAIGN = "application/vnd.spCampaign.v3+json";

function loadSeed(): LaunchSeed {
  const file = path.resolve(process.cwd(), SEED);
  const seed = parseLaunchSeed(JSON.parse(fs.readFileSync(file, "utf8")));
  const errors = validateLaunchSeed(seed);
  if (errors.length) throw new Error(`Seed ${SEED} no pasa las reglas:\n  - ${errors.join("\n  - ")}`);
  if (APPLY && seed.status !== "approved") throw new Error(`Seed ${SEED} en estado "${seed.status ?? "?"}": revísalo y pon "status": "approved" antes de ADS_APPLY=1`);
  return seed;
}

async function fbaUnits(sp: SpApiClient, seed: LaunchSeed): Promise<FbaUnits | null> {
  const res = await getInventorySummaries(sp, { marketplaceIds: [seed.marketplaceId], sellerSkus: [seed.skus.fba] });
  const s = res.payload?.inventorySummaries?.find((x) => x.sellerSku === seed.skus.fba);
  const d = s?.inventoryDetails;
  if (!d) return null;
  return { fulfillable: d.fulfillableQuantity ?? 0, inbound: (d.inboundWorkingQuantity ?? 0) + (d.inboundShippedQuantity ?? 0) + (d.inboundReceivingQuantity ?? 0) };
}

/** Average daily gross sales of the family's SKUs in the seed's country over the last 30 days. */
async function dailySales(sp: SpApiClient, seed: LaunchSeed): Promise<number> {
  const units = await new SalesService(sp, env.marketplaceIds).getSkuUnitsByChannel(new Date(Date.now() - 30 * 86_400_000).toISOString(), new Date().toISOString());
  const channel = units[salesChannelFor(seed.country) ?? ""] ?? {};
  const sold = [seed.skus.fba, seed.skus.fbm].reduce((a, sku) => a + (sku ? (channel[sku]?.units ?? 0) - (channel[sku]?.returnedUnits ?? 0) : 0), 0);
  return (Math.max(0, sold) * seed.economics.priceGross) / 30;
}

/** Ads of the FBA SKU in the launch campaigns, paused or re-enabled. */
async function setFbaAds(writer: AdsWriter, plan: CampaignPlan, sku: string, state: "ENABLED" | "PAUSED", log: ApplyLogEntry[]): Promise<number> {
  const res = await writer.post<{ campaigns?: Array<{ campaignId: string; name: string }> }>("/sp/campaigns/list", MT_CAMPAIGN, {
    nameFilter: { queryTermMatchType: "EXACT_MATCH", include: plan.campaigns.map((c) => c.name) },
    maxResults: 100,
  });
  const ids = (res.campaigns ?? []).map((c) => c.campaignId);
  if (!ids.length) return 0;
  const ads = await writer.post<{ productAds?: Array<{ adId: string; sku?: string; state?: string }> }>("/sp/productAds/list", MT_PRODUCT_AD, {
    campaignIdFilter: { include: ids },
    stateFilter: { include: ["ENABLED", "PAUSED"] },
    maxResults: 1000,
  });
  const changes = (ads.productAds ?? []).filter((a) => a.sku === sku && a.state?.toUpperCase() !== state).map((a) => ({ adId: a.adId, state }));
  if (changes.length && APPLY) await writer.put("/sp/productAds", MT_PRODUCT_AD, { productAds: changes });
  for (const c of changes) log.push({ action: `anuncio FBA → ${state}`, entity: `${sku} ${c.adId}`, detail: APPLY ? "ok" : "simulacro" });
  return changes.length;
}

function report(seed: LaunchSeed, plan: CampaignPlan, units: FbaUnits | null, sales: number): { fbaOk: boolean; tacosOk: boolean } {
  const fba = fbaReady(units, seed.minFbaUnits);
  const cap = tacosBudgetCap(sales, seed.economics.maxTacos);
  console.log(`Lanzamiento ${seed.family} · ${seed.asin} · ${seed.country} · ${APPLY ? "APLICANDO" : "SIMULACRO"} · modo ${MODE}`);
  console.log(`  FBA ${seed.skus.fba}: ${units ? `${units.fulfillable} vendibles + ${units.inbound} inbound = ${fba.total}` : "sin inventario"} (mínimo ${seed.minFbaUnits}) → ${fba.ready ? "listo" : "NO listo"}`);
  console.log(`  Presupuesto ${plan.dailyBudget} €/día · ventas medias ${sales.toFixed(2)} €/día · techo TACoS ${seed.economics.maxTacos} % → ${cap === null ? "sin ventas, sin techo calculable" : `${cap} €/día`}`);
  console.log(`  CPC al ACoS objetivo ${seed.economics.targetAcos} %: CVR 8 % → ${targetCpc(seed, 0.08)} €, 10 % → ${targetCpc(seed, 0.1)} €, 12 % → ${targetCpc(seed, 0.12)} €`);
  for (const c of plan.campaigns) {
    const g = c.adGroups[0];
    console.log(`  ${c.name} (${c.targetingType}, ${c.dailyBudget} €/día): ${g.skus.join(" + ")}, ${g.keywords.length} keywords, ${c.negativeKeywords.length} negativas, puja ${g.defaultBid} €`);
  }
  return { fbaOk: fba.ready, tacosOk: cap === null || plan.dailyBudget <= cap };
}

async function logChanges(store: AdsReportStore, profileId: string, seed: LaunchSeed, plan: CampaignPlan, log: ApplyLogEntry[], baseline: string): Promise<void> {
  const date = new Date().toISOString();
  const existing = (await store.readSnapshot<ChangeLogEntry[]>(changelogKey(profileId))) ?? [];
  const entries: ChangeLogEntry[] = plan.campaigns.map((c) => {
    // Activation and rollback log campaign ids, not names: the whole run counts for each campaign.
    const ops = MODE === "create" ? log.filter((l) => l.entity === c.name || l.entity.startsWith(`${c.name} `)) : log;
    const failed = ops.filter((l) => l.error).length;
    return {
      entityId: `launch|${c.name}|${MODE}`,
      date,
      profileId,
      country: seed.country,
      entityType: "CAMPAIGN_LAUNCH",
      text: `${c.name} (${seed.family}, ${seed.asin})`,
      action: MODE === "rollback" ? "reverted" : "applied",
      oldValue: MODE === "create" ? null : MODE === "activate" ? "PAUSED" : "ENABLED",
      newValue: MODE === "create" ? `creada EN PAUSA, ${c.dailyBudget} €/día, puja ${c.adGroups[0].defaultBid} €` : MODE === "activate" ? "ENABLED" : "PAUSED",
      baselineMetric: baseline,
      reviewDate: addDays(date, REVIEW_AFTER_DAYS),
      reason: `${seed.tacosExceptionUntil && MODE === "activate" ? `Excepción de TACoS aprobada hasta ${seed.tacosExceptionUntil}. ` : ""}Plan de lanzamiento ${SEED}: ${ops.length - failed} operaciones correctas, ${failed} errores`,
    };
  });
  await store.writeSnapshot(changelogKey(profileId), entries.reduce(appendEntry, existing));
  console.log(`Change Log: ${entries.length} entradas en ${changelogKey(profileId)}`);
}

async function main(): Promise<void> {
  if (!["create", "activate", "rollback"].includes(MODE)) throw new Error(`ADS_MODE inválido: ${MODE}`);
  const seed = loadSeed();
  const plan = buildLaunchPlan(seed);
  const ads = new AdsApiClient(env.adsApi);
  const profile = (await ads.getProfiles()).find((p) => p.countryCode === seed.country);
  if (!profile) throw new Error(`Sin perfil de Ads para ${seed.country}`);
  if (profile.accountInfo.marketplaceStringId !== seed.marketplaceId) throw new Error(`El perfil ${seed.country} es de ${profile.accountInfo.marketplaceStringId}, el seed dice ${seed.marketplaceId}`);
  const profileId = String(profile.profileId);
  const sp = new SpApiClient({ credentials: env.spApi });
  const units = await fbaUnits(sp, seed);
  const sales = await dailySales(sp, seed);
  const { fbaOk, tacosOk } = report(seed, plan, units, sales);

  const writer = ads.writer(profileId);
  const today = new Date().toISOString().slice(0, 10);
  const applier = new CampaignPlanApplier(writer, APPLY, today, { keepExistingBids: true });
  let log: ApplyLogEntry[];
  if (MODE === "activate") {
    const exception = seed.tacosExceptionUntil !== undefined && today <= seed.tacosExceptionUntil;
    if (!tacosOk && exception) console.log(`  Excepción de lanzamiento aprobada: el techo de TACoS no bloquea hasta ${seed.tacosExceptionUntil}`);
    if (!tacosOk && !exception) throw new Error(`Presupuesto ${plan.dailyBudget} €/día supera el techo de TACoS ${seed.economics.maxTacos} %: bájalo en el seed antes de activar`);
    if (!fbaOk && !seed.skus.fbm) throw new Error(`FBA por debajo de ${seed.minFbaUnits} u y sin SKU FBM: no hay nada que activar`);
    const extra: ApplyLogEntry[] = [];
    // Below the stock threshold the FBA ad stays paused and only the FBM offer serves.
    await setFbaAds(writer, plan, seed.skus.fba, fbaOk ? "ENABLED" : "PAUSED", extra);
    log = [...extra, ...(await applier.setStates(plan, "activate"))];
  } else {
    log = MODE === "create" ? await applier.applyPlan(plan) : await applier.setStates(plan, "rollback");
  }

  const errors = log.filter((l) => l.error);
  const file = path.resolve(process.cwd(), `data/ads-launch-${today}-${seed.family}-${MODE}${APPLY ? "" : "-dry"}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(log, null, 1));
  console.log(`${log.length} operaciones, ${errors.length} errores → ${file}`);
  for (const e of errors.slice(0, 10)) console.log(`   ERROR ${e.action} ${e.entity}: ${e.error}`);
  if (errors.length) process.exitCode = 1;

  if (APPLY && log.length) {
    const store =
      process.env.ADS_STORE !== "file" && env.supabase.url && env.supabase.serviceRoleKey
        ? createSupabaseAdsReportStore(env.supabase.url, env.supabase.serviceRoleKey)
        : createFileAdsReportStore(path.resolve(process.cwd(), "data/ads-reports"));
    const baseline = `FBA ${fbaReady(units, seed.minFbaUnits).total} u, ventas ${sales.toFixed(2)} €/día, presupuesto ${plan.dailyBudget} €/día`;
    await logChanges(store, profileId, seed, plan, log, baseline);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
