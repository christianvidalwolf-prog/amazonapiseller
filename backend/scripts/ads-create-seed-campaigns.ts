/**
 * Creates the launch campaigns of the Bingos 90 Profissional seed (SKU 40973, ASIN B0FX2ZVG3F, ES)
 * from `ads/keywords/40973_keywords.json` — spec advertising §10.
 *
 *   npx tsx scripts/ads-create-seed-campaigns.ts    # dry-run offline: prints every operation (no API calls, no credentials needed)
 *   ADS_APPLY=1 npx tsx scripts/ads-create-seed-campaigns.ts  # creates the 4 campaigns PAUSED in the real profile
 *
 * Idempotent by campaign/ad group name. Campaigns are always created PAUSED (stock gate:
 * FBA+inbound < 20 units today), only FBA activation once the gate is covered.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdsApiClient } from "../src/ads/adsClient";
import { env } from "../src/config/env";
import { createFileAdsReportStore, createSupabaseAdsReportStore } from "../src/modules/advertising/adsReports.store";
import { CampaignPlanApplier, type AdsWriter } from "../src/modules/advertising/campaignApply";
import type { AutoTargetingBids, CampaignPlan, PlannedAdGroup } from "../src/modules/advertising/campaignPlan";
import { addDays, appendEntry, changelogKey, REVIEW_AFTER_DAYS, type ChangeLogEntry } from "../src/modules/advertising/changelog";

const APPLY = process.env.ADS_APPLY === "1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_FILE = path.resolve(HERE, "../ads/keywords/40973_keywords.json");

interface KeywordSeed {
  text: string;
  bid: number;
  matchType?: "EXACT" | "PHRASE";
}
interface Seed {
  prefix: string;
  asin: string;
  sku: string;
  familySkus: string[];
  brand: string;
  country: string;
  budgets: Record<"auto" | "exact" | "phrase" | "brand", number>;
  defaultBids: Record<"auto" | "exact" | "phrase" | "brand", number>;
  autoBids: { close: number; loose: number; substitutes: number; complements: number };
  exact: KeywordSeed[];
  phrase: KeywordSeed[];
  brandKeywords: KeywordSeed[];
  negatives: { generic: string[]; junk: string[] };
}

/** Dry run never touches the network: applyPlan only reads the existing campaigns through this writer. */
const offlineWriter: AdsWriter = {
  post: async () => ({} as never),
  put: async () => ({} as never),
};

function buildPlan(seed: Seed): CampaignPlan {
  const skus = seed.familySkus;
  const group = (kind: "Auto" | "Exact" | "Phrase" | "Marca", keywords: PlannedAdGroup["keywords"], autoBids?: AutoTargetingBids): PlannedAdGroup => ({
    name: `${seed.prefix.replace(/^SP-/, "")}-${kind}`,
    defaultBid: seed.defaultBids[kind.toLowerCase() as keyof typeof seed.defaultBids],
    skus,
    keywords: keywords.map(({ text, matchType, bid }) => ({ text, matchType, bid })),
    targets: [],
    autoBids,
  });
  return {
    country: seed.country,
    dailyBudget: seed.budgets.auto + seed.budgets.exact + seed.budgets.phrase + seed.budgets.brand,
    campaigns: [
      {
        name: `${seed.prefix}-Auto`,
        targetingType: "AUTO",
        dailyBudget: seed.budgets.auto,
        adGroups: [group("Auto", [], seed.autoBids)],
        negativeKeywords: [...seed.negatives.generic, ...seed.negatives.junk],
        negativeAsins: [],
      },
      {
        name: `${seed.prefix}-Exact`,
        targetingType: "MANUAL",
        dailyBudget: seed.budgets.exact,
        adGroups: [group("Exact", seed.exact.map((k) => ({ ...k, matchType: "EXACT" as const })))],
        negativeKeywords: [...seed.negatives.generic],
        negativeAsins: [],
      },
      {
        name: `${seed.prefix}-Phrase`,
        targetingType: "MANUAL",
        dailyBudget: seed.budgets.phrase,
        adGroups: [group("Phrase", seed.phrase.map((k) => ({ ...k, matchType: "PHRASE" as const })))],
        negativeKeywords: [...seed.negatives.generic, ...seed.negatives.junk],
        negativeAsins: [],
      },
      {
        name: `${seed.prefix}-Marca`,
        targetingType: "MANUAL",
        dailyBudget: seed.budgets.brand,
        adGroups: [group("Marca", seed.brandKeywords.map(({ text, bid, matchType }) => ({ text, bid, matchType: matchType ?? "EXACT" })))],
        negativeKeywords: [],
        negativeAsins: [],
      },
    ],
    excluded: [],
    pauseOld: [],
    assumptions: [
      `El usuario pidió crear las ads con los 2 listings: los ad groups llevan ${seed.familySkus.join(" + ")} (ASIN ${seed.asin}).`,
      "Gate de stock FBA del spec (no activar si FBA+inbound < 20 u; hoy 4 stock + 11 inbound = 15 u): todas las campañas se crean EN PAUSA; activación solo cuando el stock cubra el gate.",
      `Nombres ${seed.prefix}-… anclados a la familia ASIN con 1 ad group de ambas variantes por campaña (desviación documentada del patrón 1 seller-agrupación por ASIN del spec §3.6).`,
      "Semillas de Search Query Performance ES (L3M + MONTH, snapshot 2026-10-24) con pujas 0,35–0,60 € alineadas al objetivo ACoS 19% (break-even 24,3%); negativa de marca en las 3 campañas genéricas para no canibalizar la de Marca.",
    ],
  };
}

async function main(): Promise<void> {
  const seed: Seed = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
  const plan = buildPlan(seed);
  const today = new Date().toISOString().slice(0, 10);

  let writer: AdsWriter = offlineWriter;
  let profileId = "";
  if (APPLY) {
    profileId = env.adsApi.profileId ?? "";
    if (!profileId || !env.adsApi.lwaClientId || !env.adsApi.refreshToken) {
      throw new Error("Credenciales Ads incompletas: genera el refresh token con backend/scripts/ads_auth_helper.py (ADS_API_REFRESH_TOKEN / ADS_API_PROFILE_ID en backend/.env)");
    }
    writer = new AdsApiClient(env.adsApi).writer(profileId);
  } else {
    console.log("SIMULACRO (sin credenciales Ads): nada se envía a Amazon");
  }
  console.log(`${APPLY ? "APLICANDO" : ""} plan ${seed.prefix} · ES · presupuesto total ${plan.dailyBudget} €/día · ${plan.campaigns.length} campañas PAUSED`);

  const applier = new CampaignPlanApplier(writer, APPLY, today);
  const log = await applier.applyPlan(plan);
  const errors = log.filter((l) => l.error);
  const file = path.resolve(HERE, `../../data/ads-seed-40973-create-${today}${APPLY ? "" : "-dry"}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ plan, log }, null, 1));
  console.log(`${log.length} operaciones, ${errors.length} errores → ${file}`);

  if (!APPLY) {
    for (const e of log) console.log(`  [${e.action}] ${e.entity} — ${e.detail}`);
  }
  for (const e of errors.slice(0, 10)) console.log(`  ERROR ${e.action} ${e.entity}: ${e.error}`);

  if (APPLY) {
    const store =
      process.env.ADS_STORE !== "file" && env.supabase.url && env.supabase.serviceRoleKey
        ? createSupabaseAdsReportStore(env.supabase.url, env.supabase.serviceRoleKey)
        : createFileAdsReportStore(path.resolve(process.cwd(), "data/ads-reports"));
    const existing = (await store.readSnapshot<ChangeLogEntry[]>(changelogKey(profileId))) ?? [];
    const entry: ChangeLogEntry = {
      entityId: `seed-40973|${today}|create`,
      date: new Date().toISOString(),
      profileId,
      country: seed.country,
      entityType: "CAMPAIGN_PLAN",
      text: `Semillas ${seed.prefix} (${plan.campaigns.length} campañas PAUSED, FBA+FBM)`,
      action: "applied",
      oldValue: null,
      newValue: `${plan.campaigns.length} campañas nuevas EN PAUSA (${plan.dailyBudget} €/día)`,
      baselineMetric: stock_gate(),
      reviewDate: addDays(new Date().toISOString(), REVIEW_AFTER_DAYS),
      reason: `${log.length - errors.length} operaciones correctas, ${errors.length} errores`,
    };
    await store.writeSnapshot(changelogKey(profileId), appendEntry(existing, entry));
    console.log("Change Log actualizado");
  }
  if (errors.length) process.exitCode = 1;
}

function stock_gate(): string {
  return "stock gate FBA 15/20 u (4 stock + 11 inbound): activar solo cuando cubra 20 u";
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
