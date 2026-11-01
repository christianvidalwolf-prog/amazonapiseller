/**
 * Small exact-match pilot for an SQP winner, protected by live offer/stock checks and a daily stop.
 *
 *   node --import tsx scripts/ads-sqp-pilot.ts                 # read-only dry run
 *   ADS_APPLY=1 node --import tsx scripts/ads-sqp-pilot.ts      # create, then activate the one campaign
 *   ADS_SQP_MODE=watch ADS_APPLY=1 node --import tsx scripts/ads-sqp-pilot.ts
 *
 * The daily watcher pauses the campaign if country PF ACoS or term ACoS exceeds 25%, it spends
 * €3 without orders, or either Ads report is stale. It is called after report sync.
 */
import fs from "node:fs";
import path from "node:path";
import { AdsApiClient } from "../src/ads/adsClient";
import { env } from "../src/config/env";
import type { CampaignPlan } from "../src/modules/advertising/campaignPlan";
import { CampaignPlanApplier } from "../src/modules/advertising/campaignApply";
import { appendEntry, type ChangeLogEntry, changelogKey, addDays, REVIEW_AFTER_DAYS } from "../src/modules/advertising/changelog";
import { type AdsReportStore, adsReportKey, createFileAdsReportStore, createSupabaseAdsReportStore } from "../src/modules/advertising/adsReports.store";
import type { AdvertisedProductReportRow, CampaignReportRow, SearchTermReportRow } from "../src/ads/reportTypes";
import { loadStockSnapshot } from "./lib/listing-archive-store";
import { PricingService } from "../src/modules/pricing/pricing.service";
import { SpApiClient } from "../src/spapi/client";
import { getInventorySummaries } from "../src/spapi/endpoints/fbaInventory";
import { createSupabaseSearchQueryMetricsRepository } from "../src/modules/brand-analytics/searchFunnel.supabaseRepository";
import type { SearchQueryMetricsRepository } from "../src/modules/brand-analytics/searchFunnel.repository";

type Pilot = {
  status: string; country: string; marketplaceId: string; asin: string; sku: string; fulfillment: "FBM" | "FBA";
  term: string; bidEur: number; dailyBudgetEur: number; targetAcosPct: number; absoluteBidCapEur: number;
  stopLossSpendWithoutSalesEur: number; maxReportAgeDays: number; campaignName: string; adGroupName: string;
  allowCountryAcosException?: boolean; minBaselineClicks?: number; minBaselineOrders?: number;
  requireSqpWinner?: boolean; sqpMaxAgeDays?: number; autoLaunchWhenReady?: boolean;
};
const defaultSeed = "ads/keywords/sqp-pilot-lagarto-es.json";
function readPilotSeed(file: string): Pilot {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file.trim()), "utf8")) as Pilot;
}
let pilot = readPilotSeed(process.env.ADS_SQP_SEED ?? defaultSeed);
const APPLY = process.env.ADS_APPLY === "1";
const MODE = process.env.ADS_SQP_MODE ?? "launch";
const store: AdsReportStore = process.env.ADS_STORE === "file" || !env.supabase.url || !env.supabase.serviceRoleKey
  ? createFileAdsReportStore(path.resolve(process.cwd(), "data/ads-reports"))
  : createSupabaseAdsReportStore(env.supabase.url, env.supabase.serviceRoleKey);
const mtCampaign = "application/vnd.spCampaign.v3+json";
const mtKeyword = "application/vnd.spKeyword.v3+json";
const sqpRepository: SearchQueryMetricsRepository | null = env.supabase.url && env.supabase.serviceRoleKey
  ? createSupabaseSearchQueryMetricsRepository(env.supabase.url, env.supabase.serviceRoleKey)
  : null;

function campaignPlan(): CampaignPlan {
  return {
    country: pilot.country,
    dailyBudget: pilot.dailyBudgetEur,
    excluded: [],
    pauseOld: [],
    assumptions: [`Piloto SQP ${pilot.asin} / ${pilot.term}; límite diario ${pilot.dailyBudgetEur} €, puja ${pilot.bidEur} €, ACoS máximo ${pilot.targetAcosPct} %`],
    campaigns: [{
      name: pilot.campaignName,
      targetingType: "MANUAL",
      dailyBudget: pilot.dailyBudgetEur,
      negativeKeywords: [],
      negativeAsins: [],
      adGroups: [{
        name: pilot.adGroupName,
        defaultBid: pilot.bidEur,
        skus: [pilot.sku],
        keywords: [{ text: pilot.term, matchType: "EXACT", bid: pilot.bidEur }],
        targets: [],
      }],
    }],
  };
}

async function activeProfile(ads: AdsApiClient) {
  const p = (await ads.getProfiles()).find((x) => x.countryCode === pilot.country);
  if (!p || p.accountInfo.marketplaceStringId !== pilot.marketplaceId) throw new Error("Perfil o marketplace de Ads no coincide con el piloto");
  return p;
}

async function checkLaunchReadiness(): Promise<{ stock: number; price: number; margin: number; marginPct: number }> {
  if (pilot.status !== "approved") throw new Error("El piloto no está aprobado");
  if (pilot.bidEur < 0.02 || pilot.bidEur > pilot.absoluteBidCapEur || pilot.absoluteBidCapEur > 1.5) throw new Error("Puja fuera de los límites definidos");
  if (pilot.dailyBudgetEur < 1 || pilot.dailyBudgetEur > 1) throw new Error("El presupuesto del piloto debe permanecer en 1 €/día");
  if (pilot.targetAcosPct !== 25) throw new Error("ACoS objetivo debe respetar el límite del 25 %");
  let qty = 0;
  if (pilot.fulfillment === "FBM") {
    const stock = await loadStockSnapshot();
    if (!stock || Date.now() - Date.parse(stock.updatedAt) > 48 * 60 * 60_000) throw new Error("Snapshot de stock ausente o con más de 48 h");
    qty = Number(stock.items.find((x) => String(x.sku) === pilot.sku)?.quantity ?? 0);
  } else {
    const inventory = await getInventorySummaries(new SpApiClient({ credentials: env.spApi }), { marketplaceIds: [pilot.marketplaceId], sellerSkus: [pilot.sku] });
    qty = Number(inventory.payload.inventorySummaries.find((x) => x.sellerSku === pilot.sku && x.asin === pilot.asin)?.inventoryDetails?.fulfillableQuantity ?? 0);
  }
  if (qty < 1) throw new Error(`Sin stock vendible ${pilot.fulfillment} para ${pilot.sku}`);
  if (pilot.requireSqpWinner || pilot.allowCountryAcosException) {
    if (!sqpRepository) throw new Error("No hay repositorio SQP conectado para validar el término");
    const stored = await sqpRepository.latest(pilot.marketplaceId, "WEEK", 1);
    const metric = stored?.metrics
      .filter((row) => row.asin === pilot.asin && row.queryText.trim().toLocaleLowerCase() === pilot.term.trim().toLocaleLowerCase())
      .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
    const sqpAgeDays = metric?.periodEnd ? (Date.now() - Date.parse(`${metric.periodEnd}T23:59:59Z`)) / 86_400_000 : Infinity;
    if (!metric || sqpAgeDays > (pilot.sqpMaxAgeDays ?? 14)) throw new Error("No hay señal SQP reciente para este ASIN y término exacto");
    if (metric.asinPurchases < 1 || metric.asinPurchaseShare <= metric.asinClickShare) throw new Error("El ASIN ya no supera su cuota de compras frente a clics en SQP");
  }
  const pricing = new PricingService(new SpApiClient({ credentials: env.spApi }), pilot.marketplaceId, env.sellerId);
  const fulfilled = pilot.fulfillment === "FBA" ? "amazon" : "merchant";
  const [margin, offers] = await Promise.all([pricing.getUnitMargin(pilot.sku, { fulfilled }), pricing.getProductOffersDetail(pilot.asin)]);
  const ownBuyBox = offers.offers.some((o) => o.isMyOffer && o.isBuyBoxWinner);
  if (!ownBuyBox) throw new Error(`El vendedor no tiene Buy Box para ${pilot.asin}`);
  if (margin.margin === null || margin.margin <= 0 || margin.price <= 0) throw new Error("Falta margen/precio positivo para el SKU");
  const breakEvenAcos = (margin.margin / margin.price) * 100;
  if (breakEvenAcos <= pilot.targetAcosPct) throw new Error(`Margen de equilibrio ${breakEvenAcos.toFixed(1)} % no cubre el ACoS objetivo`);
  return { stock: qty, price: margin.price, margin: margin.margin, marginPct: margin.marginPct ?? 0 };
}

async function hasProfitableSameSkuBaseline(profileId: string): Promise<{ eligible: boolean; acos: number | null; clicks: number; orders: number }> {
  const report = await store.load<AdvertisedProductReportRow>(profileId, "advertisedProducts");
  const ageDays = report?.endDate ? (Date.now() - Date.parse(`${report.endDate}T00:00:00Z`)) / 86_400_000 : Infinity;
  if (!report || !report.endDate || ageDays > pilot.maxReportAgeDays) return { eligible: false, acos: null, clicks: 0, orders: 0 };
  const rows = report.rows.filter((r) => r.advertisedAsin === pilot.asin && r.advertisedSku === pilot.sku);
  const spend = rows.reduce((n, r) => n + (Number(r.cost) || 0), 0);
  const sales = rows.reduce((n, r) => n + (Number(r.attributedSalesSameSku7d) || 0), 0);
  const clicks = rows.reduce((n, r) => n + (Number(r.clicks) || 0), 0);
  const orders = rows.reduce((n, r) => n + (Number(r.unitsSoldSameSku7d) || 0), 0);
  const acos = sales > 0 ? (spend / sales) * 100 : null;
  return { eligible: clicks >= (pilot.minBaselineClicks ?? 10) && orders >= (pilot.minBaselineOrders ?? 2) && acos !== null && acos <= pilot.targetAcosPct, acos, clicks, orders };
}

async function countryAcosAllowed(profileId: string, countryAcos: number | null): Promise<boolean> {
  if (countryAcos !== null && countryAcos <= pilot.targetAcosPct) return true;
  if (countryAcos === null || !pilot.allowCountryAcosException) return false;
  return (await hasProfitableSameSkuBaseline(profileId)).eligible;
}

async function launch(ads: AdsApiClient, profileId: string): Promise<void> {
  const live = await checkLaunchReadiness();
  const countryReport = await store.load<CampaignReportRow>(profileId, "campaigns");
  const countryReportAge = countryReport?.endDate ? (Date.now() - Date.parse(`${countryReport.endDate}T00:00:00Z`)) / 86_400_000 : Infinity;
  if (!countryReport || !countryReport.endDate || countryReportAge > pilot.maxReportAgeDays) throw new Error("No lanzar: informe de campañas ausente o desactualizado");
  const pfRows = countryReport?.rows.filter((r) => (r.campaignName ?? "").startsWith("PF |")) ?? [];
  const countrySpend = pfRows.reduce((n, r) => n + (Number(r.cost) || 0), 0);
  const countrySales = pfRows.reduce((n, r) => n + (Number(r.sales7d) || 0), 0);
  const countryAcos = countrySales > 0 ? (countrySpend / countrySales) * 100 : null;
  if (countryAcos === null || !(await countryAcosAllowed(profileId, countryAcos))) {
    const acos = countrySales > 0 ? `${((countrySpend / countrySales) * 100).toFixed(1)} %` : "sin ventas atribuibles";
    throw new Error(`No lanzar: ACoS PF de ${pilot.country} ${acos}; el límite es ${pilot.targetAcosPct} %`);
  }
  if (countryAcos > pilot.targetAcosPct) {
    const baseline = await hasProfitableSameSkuBaseline(profileId);
    console.log(`Excepción de piloto ASIN: ACoS del mismo SKU ${baseline.acos?.toFixed(1)} % con ${baseline.clicks} clics y ${baseline.orders} unidades.`);
  }
  const campaigns = await ads.listSponsoredProductsCampaigns(profileId);
  const activePfBudget = campaigns.filter((c) => c.name.startsWith("PF |") && c.state === "enabled").reduce((n, c) => n + c.dailyBudget, 0);
  const existingPilot = campaigns.find((c) => c.name === pilot.campaignName);
  const additionalBudget = existingPilot?.state === "enabled" ? 0 : pilot.dailyBudgetEur;
  const cap = Number(process.env.ADS_OPTIMIZER_BUDGET_ES ?? 42);
  if (activePfBudget + additionalBudget > cap) throw new Error(`El nuevo presupuesto excedería el tope PF ES de ${cap} €/día`);
  const plan = campaignPlan();
  const executor = new CampaignPlanApplier(ads.writer(profileId), APPLY, new Date().toISOString().slice(0, 10));
  const changes = await executor.applyPlan(plan);
  if (changes.some((c) => c.error)) throw new Error(`Fallo al crear la campaña: ${JSON.stringify(changes.filter((c) => c.error))}`);
  console.log(`Plan ${APPLY ? "aplicado" : "simulado"}: ${pilot.campaignName}, ${pilot.term} EXACT, ${pilot.sku}, ${pilot.bidEur} €/clic, ${pilot.dailyBudgetEur} €/día; stock ${live.stock}, margen ${live.margin.toFixed(2)} € (${live.marginPct} %), Buy Box verificada.`);
  if (!APPLY) return;

  // Creating the campaign paused is the first operation; activate only after every component succeeded.
  const activated = await executor.setStates(plan, "activate");
  if (activated.some((c) => c.error) || !activated.some((c) => c.action === "activar")) throw new Error(`La campaña quedó creada pero no pudo confirmarse activa: ${JSON.stringify(activated)}`);
  const liveCampaign = (await ads.listSponsoredProductsCampaigns(profileId)).find((c) => c.name === pilot.campaignName);
  if (liveCampaign?.state !== "enabled") throw new Error(`Amazon no confirma ENABLED para ${pilot.campaignName}`);
  const entries = (await store.readSnapshot<ChangeLogEntry[]>(changelogKey(profileId))) ?? [];
  const date = new Date().toISOString();
  const entry: ChangeLogEntry = {
    entityId: `sqp-pilot|${pilot.campaignName}|launch`, date, profileId, country: pilot.country,
    entityType: "CAMPAIGN_LAUNCH", text: `${pilot.asin} · ${pilot.term} · ${pilot.sku}`,
    action: "applied", oldValue: "no campaña aislada", newValue: `ENABLED · ${pilot.dailyBudgetEur} €/día · ${pilot.bidEur} € puja`,
    baselineMetric: `stock ${pilot.fulfillment} ${live.stock}; precio ${live.price} €; margen ${live.margin} €; Buy Box propia`,
    reviewDate: addDays(date, REVIEW_AFTER_DAYS), reason: "Piloto de término SQP autorizado por el usuario; stop diario de ACoS / gasto sin ventas",
  };
  await store.writeSnapshot(changelogKey(profileId), appendEntry(entries, entry));
}

async function watch(ads: AdsApiClient, profileId: string): Promise<void> {
  const report = await store.load<SearchTermReportRow>(profileId, "searchTerms");
  const campaignReport = await store.load<CampaignReportRow>(profileId, "campaigns");
  const today = new Date();
  const ageDays = report?.endDate ? (today.getTime() - Date.parse(`${report.endDate}T00:00:00Z`)) / 86_400_000 : Infinity;
  if (!report || !report.endDate || ageDays > pilot.maxReportAgeDays) {
    await pause(`Informe de términos ausente o desactualizado (${report?.endDate ?? "sin fecha"})`, ads, profileId);
    return;
  }
  const campaignAgeDays = campaignReport?.endDate ? (today.getTime() - Date.parse(`${campaignReport.endDate}T00:00:00Z`)) / 86_400_000 : Infinity;
  if (!campaignReport || !campaignReport.endDate || campaignAgeDays > pilot.maxReportAgeDays) {
    await pause("Informe de campañas ausente o desactualizado", ads, profileId);
    return;
  }
  try {
    await checkLaunchReadiness();
  } catch (err) {
    await pause(`Guardia de producto: ${err instanceof Error ? err.message : String(err)}`, ads, profileId);
    return;
  }
  const pfRows = campaignReport.rows.filter((r) => (r.campaignName ?? "").startsWith("PF |"));
  const countrySpend = pfRows.reduce((n, r) => n + (Number(r.cost) || 0), 0);
  const countrySales = pfRows.reduce((n, r) => n + (Number(r.sales7d) || 0), 0);
  const countryAcos = countrySales > 0 ? (countrySpend / countrySales) * 100 : null;
    if (countryAcos === null || !(await countryAcosAllowed(profileId, countryAcos))) {
      await pause(countryAcos === null
        ? `ACoS PF de ${pilot.country} no calculable: sin ventas atribuibles`
        : `ACoS PF de ${pilot.country} ${countryAcos.toFixed(1)} % > ${pilot.targetAcosPct} %`, ads, profileId);
    return;
  }
  const writer = ads.writer(profileId);
  let campaignToken: string | undefined;
  let campaignId: string | undefined;
  let campaignState: string | undefined;
  do {
    const res = await writer.post<{ campaigns?: Array<{ campaignId: string; name: string; state?: string; budget?: { budget?: number; budgetType?: string } }>; nextToken?: string }>("/sp/campaigns/list", mtCampaign, {
      stateFilter: { include: ["ENABLED", "PAUSED"] }, maxResults: 1000, ...(campaignToken ? { nextToken: campaignToken } : {}),
    });
    const campaign = res.campaigns?.find((c) => c.name === pilot.campaignName);
    campaignId = campaign?.campaignId;
    campaignState = campaign?.state;
    if (campaign && Number(campaign.budget?.budget) > pilot.dailyBudgetEur) {
      if (APPLY) await writer.put("/sp/campaigns", mtCampaign, { campaigns: [{ campaignId: campaign.campaignId, budget: { budgetType: "DAILY", budget: pilot.dailyBudgetEur } }] });
      console.log(`${APPLY ? "Tope restaurado" : "Simulacro de tope"}: presupuesto ${campaign.budget?.budget} → ${pilot.dailyBudgetEur} €/día`);
      if (APPLY) {
        const entries = (await store.readSnapshot<ChangeLogEntry[]>(changelogKey(profileId))) ?? [];
        const date = new Date().toISOString();
    const entry: ChangeLogEntry = {
          entityId: `sqp-pilot|${pilot.campaignName}|budget|${date.slice(0, 10)}`, date, profileId, country: pilot.country,
          entityType: "CAMPAIGN_BUDGET", text: pilot.campaignName, action: "applied",
          oldValue: `${campaign.budget?.budget} €/día`, newValue: `${pilot.dailyBudgetEur} €/día`,
          baselineMetric: "límite fijo del piloto SQP", reviewDate: addDays(date, REVIEW_AFTER_DAYS), reason: "Restaurar el techo diario del piloto después del optimizador general",
        };
        await store.writeSnapshot(changelogKey(profileId), appendEntry(entries, entry));
      }
    }
    campaignToken = res.nextToken;
  } while (!campaignId && campaignToken);
  if (!campaignId) {
    if (pilot.autoLaunchWhenReady) {
      console.log(`Watcher: ${pilot.campaignName} supera las guardas; creando piloto autorizado.`);
      await launch(ads, profileId);
    } else {
      console.log("Watcher: la campaña todavía no existe");
    }
    return;
  }
  const groupResponse = await writer.post<{ adGroups?: Array<{ adGroupId: string; name: string }> }>("/sp/adGroups/list", "application/vnd.spAdGroup.v3+json", {
    campaignIdFilter: { include: [campaignId] }, maxResults: 100,
  });
  const adGroupId = groupResponse.adGroups?.find((g) => g.name === pilot.adGroupName)?.adGroupId;
  let token: string | undefined;
  const keywords: Array<{ keywordId: string; keywordText: string; campaignId: string }> = [];
  do {
    const res = await writer.post<{ keywords?: Array<{ keywordId: string; keywordText: string; campaignId: string }>; nextToken?: string }>("/sp/keywords/list", mtKeyword, {
      campaignIdFilter: { include: [campaignId] }, stateFilter: { include: ["ENABLED", "PAUSED"] }, maxResults: 1000, ...(token ? { nextToken: token } : {}),
    });
    keywords.push(...(res.keywords ?? [])); token = res.nextToken;
  } while (token);
  const candidate = keywords.find((k) => k.keywordText.toLowerCase() === pilot.term.toLowerCase() && String(k.campaignId) === String(campaignId));
  if (!candidate) { console.log("Watcher: aún no existe keyword del piloto"); return; }
  const rows = report.rows.filter((r) =>
    String(r.keywordId ?? "") === String(candidate.keywordId) ||
    (adGroupId !== undefined && String(r.adGroupId ?? "") === String(adGroupId) && (r.searchTerm ?? "").trim().toLowerCase() === pilot.term.toLowerCase())
  );
  const spend = rows.reduce((n, r) => n + (Number(r.cost) || 0), 0);
  const sales = rows.reduce((n, r) => n + (Number(r.sales7d) || 0), 0);
  const orders = rows.reduce((n, r) => n + (Number(r.purchases7d) || 0), 0);
  console.log(`Watcher ${pilot.term}: ${report.startDate}–${report.endDate}; gasto ${spend.toFixed(2)} €, ventas ${sales.toFixed(2)} €, pedidos ${orders}`);
  if ((sales > 0 && (spend / sales) * 100 > pilot.targetAcosPct) || (sales === 0 && spend >= pilot.stopLossSpendWithoutSalesEur)) {
    await pause(sales > 0 ? `ACoS ${((spend / sales) * 100).toFixed(1)} % > ${pilot.targetAcosPct} %` : `${spend.toFixed(2)} € sin ventas`, ads, profileId);
    return;
  }
  if ((campaignState ?? "").toUpperCase() === "PAUSED") await resumeIfWatcherPaused(ads, profileId, campaignId, spend, sales);
}

async function resumeIfWatcherPaused(ads: AdsApiClient, profileId: string, campaignId: string, termSpend: number, termSales: number): Promise<void> {
  const entries = (await store.readSnapshot<ChangeLogEntry[]>(changelogKey(profileId))) ?? [];
  const lastPilotAction = entries.find((e) => e.entityId.startsWith(`sqp-pilot|${pilot.campaignName}|`));
  if (!lastPilotAction || !lastPilotAction.entityId.includes("|pause") || lastPilotAction.newValue !== "PAUSED" || !lastPilotAction.reason.startsWith("ACoS PF de ")) return;
  if (termSales > 0 && (termSpend / termSales) * 100 > pilot.targetAcosPct) return;
  if (termSales === 0 && termSpend >= pilot.stopLossSpendWithoutSalesEur) return;

  const live = await checkLaunchReadiness();
  const campaigns = await ads.listSponsoredProductsCampaigns(profileId);
  const activePfBudget = campaigns.filter((c) => c.name.startsWith("PF |") && c.state === "enabled").reduce((n, c) => n + c.dailyBudget, 0);
  const cap = Number(process.env.ADS_OPTIMIZER_BUDGET_ES ?? 42);
  if (activePfBudget + pilot.dailyBudgetEur > cap) {
    console.log(`Watcher: mantiene pausada ${pilot.campaignName}; reactivarla excedería ${cap} €/día`);
    return;
  }
  if (!APPLY) {
    console.log(`Reactivación simulada: ${pilot.campaignName}; ACoS PF ≤${pilot.targetAcosPct} %, stock ${live.stock}, margen ${live.margin.toFixed(2)} €, Buy Box propia.`);
    return;
  }

  await ads.writer(profileId).put("/sp/campaigns", mtCampaign, { campaigns: [{ campaignId, state: "ENABLED", budget: { budgetType: "DAILY", budget: pilot.dailyBudgetEur } }] });
  const verified = (await ads.listSponsoredProductsCampaigns(profileId)).find((c) => c.campaignId === campaignId);
  if (verified?.state !== "enabled") throw new Error(`Amazon no confirma ENABLED al reactivar ${pilot.campaignName}`);
  const date = new Date().toISOString();
  const entry: ChangeLogEntry = {
    entityId: `sqp-pilot|${pilot.campaignName}|resume|${date.slice(0, 10)}`, date, profileId, country: pilot.country,
    entityType: "CAMPAIGN_LAUNCH", text: `${pilot.asin} · ${pilot.term} · ${pilot.sku}`, action: "applied",
    oldValue: "PAUSED", newValue: `ENABLED · ${pilot.dailyBudgetEur} €/día · ${pilot.bidEur} € puja`,
    baselineMetric: `ACoS PF país dentro del 25 %; gasto término ${termSpend.toFixed(2)} €; ventas ${termSales.toFixed(2)} €; stock ${live.stock}; margen ${live.margin.toFixed(2)} €; Buy Box propia`,
    reviewDate: addDays(date, REVIEW_AFTER_DAYS), reason: "Reactivación automática tras recuperación del ACoS PF del país; campaña pausada previamente por el watcher",
  };
  await store.writeSnapshot(changelogKey(profileId), appendEntry(entries, entry));
  console.log(`REACTIVADA ${pilot.campaignName}: ACoS PF ≤${pilot.targetAcosPct} %, stock ${live.stock}, margen ${live.margin.toFixed(2)} €, Buy Box propia.`);
}

async function pause(reason: string, ads: AdsApiClient, profileId: string): Promise<void> {
  const w = ads.writer(profileId);
  let token: string | undefined;
  do {
    const res = await w.post<{ campaigns?: Array<{ campaignId: string; name: string; state: string }>; nextToken?: string }>("/sp/campaigns/list", mtCampaign, {
      stateFilter: { include: ["ENABLED", "PAUSED"] }, maxResults: 1000, ...(token ? { nextToken: token } : {}),
    });
    const c = (res.campaigns ?? []).find((x) => x.name === pilot.campaignName);
    if (c) {
      const wasEnabled = c.state === "ENABLED";
      if (wasEnabled && APPLY) await w.put("/sp/campaigns", mtCampaign, { campaigns: [{ campaignId: c.campaignId, state: "PAUSED" }] });
      console.log(`${APPLY ? "PAUSADA" : "Pausar simulacro"} ${pilot.campaignName}: ${reason}`);
      if (APPLY && wasEnabled) {
        const entries = (await store.readSnapshot<ChangeLogEntry[]>(changelogKey(profileId))) ?? [];
        const date = new Date().toISOString();
        const entry: ChangeLogEntry = {
          entityId: `sqp-pilot|${pilot.campaignName}|pause|${date.slice(0, 10)}`, date, profileId, country: pilot.country,
          entityType: "CAMPAIGN_LAUNCH", text: pilot.campaignName, action: "applied", oldValue: "ENABLED", newValue: "PAUSED",
          baselineMetric: "regla de piloto: ACoS ≤25 % y pérdida máxima 3 € sin ventas", reviewDate: addDays(date, REVIEW_AFTER_DAYS), reason,
        };
        await store.writeSnapshot(changelogKey(profileId), appendEntry(entries, entry));
      }
      return;
    }
    token = res.nextToken;
  } while (token);
  console.log("Watcher: campaña no encontrada");
}

async function main(): Promise<void> {
  if (MODE !== "launch" && MODE !== "watch") throw new Error(`ADS_SQP_MODE inválido: ${MODE}`);
  const ads = new AdsApiClient(env.adsApi);
  const configuredSeeds = MODE === "watch" ? process.env.ADS_SQP_SEEDS : process.env.ADS_SQP_SEED;
  const seedFiles = (configuredSeeds ?? defaultSeed).split(",").map((x) => x.trim()).filter(Boolean);
  for (const seedFile of seedFiles) {
    pilot = readPilotSeed(seedFile);
    try {
      const profile = await activeProfile(ads);
      if (MODE === "launch") await launch(ads, String(profile.profileId));
      else await watch(ads, String(profile.profileId));
    } catch (err) {
      console.error(`${pilot.campaignName}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
