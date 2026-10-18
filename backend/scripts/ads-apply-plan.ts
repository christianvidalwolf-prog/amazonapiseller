/**
 * Creates the profit-first campaign plan (`npm run ads:plan`) in Amazon Ads — spec advertising §10.
 *
 *   npm run ads:apply-plan                                   # dry run, ES/DE/FR/IT: prints every call
 *   ADS_APPLY=1 ADS_PLAN_COUNTRIES=ES npm run ads:apply-plan # creates ES campaigns PAUSED
 *   ADS_MODE=activate ADS_APPLY=1 ...                        # enables the new ones, pauses the old ones
 *   ADS_MODE=rollback ADS_APPLY=1 ...                        # pauses the new ones, re-enables the old ones
 *
 * Idempotent (by campaign/ad group name). Every applied change goes to the Change Log
 * (`ads:changelog:<profileId>`) with a review date 14 days ahead.
 */
import fs from "node:fs";
import path from "node:path";
import { AdsApiClient } from "../src/ads/adsClient";
import { env } from "../src/config/env";
import { adsPlanKey, createFileAdsReportStore, createSupabaseAdsReportStore } from "../src/modules/advertising/adsReports.store";
import { CampaignPlanApplier } from "../src/modules/advertising/campaignApply";
import type { CampaignPlan } from "../src/modules/advertising/campaignPlan";
import { addDays, appendEntry, type ChangeLogEntry, changelogKey, REVIEW_AFTER_DAYS } from "../src/modules/advertising/changelog";

const COUNTRIES = (process.env.ADS_PLAN_COUNTRIES ?? "ES,DE,FR,IT").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
const APPLY = process.env.ADS_APPLY === "1";
const MODE = (process.env.ADS_MODE ?? "create") as "create" | "activate" | "rollback";

async function main(): Promise<void> {
  if (!["create", "activate", "rollback"].includes(MODE)) throw new Error(`ADS_MODE inválido: ${MODE}`);
  const ads = new AdsApiClient(env.adsApi);
  const store =
    process.env.ADS_STORE !== "file" && env.supabase.url && env.supabase.serviceRoleKey
      ? createSupabaseAdsReportStore(env.supabase.url, env.supabase.serviceRoleKey)
      : createFileAdsReportStore(path.resolve(process.cwd(), "data/ads-reports"));
  const today = new Date().toISOString().slice(0, 10);
  const profiles = (await ads.getProfiles()).filter((p) => COUNTRIES.includes(p.countryCode));
  console.log(`${APPLY ? "APLICANDO" : "SIMULACRO"} · modo ${MODE} · ${profiles.map((p) => p.countryCode).join(", ")}`);

  for (const p of profiles) {
    const profileId = String(p.profileId);
    const plan = await store.readSnapshot<CampaignPlan & { generatedAt?: string }>(adsPlanKey(profileId));
    if (!plan) {
      console.warn(`${p.countryCode}: sin plan (ejecuta npm run ads:plan)`);
      process.exitCode = 1;
      continue;
    }
    const applier = new CampaignPlanApplier(ads.writer(profileId), APPLY, today);
    const log = MODE === "create" ? await applier.applyPlan(plan) : await applier.setStates(plan, MODE);
    const errors = log.filter((l) => l.error);
    const file = path.resolve(process.cwd(), `data/ads-apply-${today}-${p.countryCode}-${MODE}${APPLY ? "" : "-dry"}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(log, null, 1));
    console.log(`${p.countryCode}: ${log.length} operaciones, ${errors.length} errores → ${file}`);
    for (const e of errors.slice(0, 10)) console.log(`   ERROR ${e.action} ${e.entity}: ${e.error}`);
    if (errors.length) process.exitCode = 1;

    if (APPLY) {
      const date = new Date().toISOString();
      const existing = (await store.readSnapshot<ChangeLogEntry[]>(changelogKey(profileId))) ?? [];
      const entry: ChangeLogEntry = {
        entityId: `plan|${plan.generatedAt ?? today}|${MODE}`,
        date,
        profileId,
        country: p.countryCode,
        entityType: "CAMPAIGN_PLAN",
        text: `Plan profit-first (${plan.campaigns.length} campañas)`,
        action: MODE === "rollback" ? "reverted" : "applied",
        oldValue: MODE === "activate" ? `${plan.pauseOld.length} campañas antiguas activas` : null,
        newValue: MODE === "create" ? "campañas creadas EN PAUSA" : MODE === "activate" ? "campañas nuevas activas, antiguas en pausa" : "campañas nuevas en pausa, antiguas reactivadas",
        baselineMetric: `presupuesto plan ${plan.dailyBudget} €/día`,
        reviewDate: addDays(date, REVIEW_AFTER_DAYS),
        reason: `${log.length - errors.length} operaciones correctas, ${errors.length} errores`,
      };
      await store.writeSnapshot(changelogKey(profileId), appendEntry(existing, entry));
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
