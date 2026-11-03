/**
 * Agente diario de optimización de presupuesto (`npm run ads:optimizer`) — spec advertising §14.
 *
 * Después de `ads:daily` (guardia + regulador de pujas), redistribuye el presupuesto ENTRE campañas
 * profit-first: las ganadoras (ACoS ≤ 20 %) limitadas por presupuesto crecen hasta +25 %/día; las
 * perdedoras (ACoS > 30 % con ≥ 30 clics, o ≥ 2 € sin ventas) y las ociosas ceden hasta −25 %.
 * El total nunca sube (salvo tope explícito ADS_OPTIMIZER_BUDGET_<CC>). Todo queda en el Change Log.
 *
 *   npm run ads:optimizer                             # simulacro ES/DE/FR/IT
 *   ADS_OPTIMIZER_COUNTRIES=ES ADS_APPLY=1 npm run ads:optimizer
 */
import path from "node:path";
import { AdsApiClient } from "../src/ads/adsClient";
import { env } from "../src/config/env";
import { createFileAdsReportStore, createSupabaseAdsReportStore, adsReportKey } from "../src/modules/advertising/adsReports.store";
import { rebalanceBudgets, type CampaignMetrics } from "../src/modules/advertising/budgetOptimizer";
import { addDays, appendEntry, changelogKey, REVIEW_AFTER_DAYS, type ChangeLogEntry } from "../src/modules/advertising/changelog";
import { PREFIX } from "./lib/ads-proposals";

const COUNTRIES = (process.env.ADS_OPTIMIZER_COUNTRIES ?? "ES,DE,FR,IT").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
const APPLY = process.env.ADS_APPLY === "1";
const OPTIMIZED_AT = 7; // días sin tocar una campaña que ya ajustó el optimizador

interface CampaignReportRow { campaignId: string; campaignName: string; campaignStatus: string; cost: number | null; sales7d: number | null; clicks: number | null }
interface ReportSnapshot { startDate?: string; endDate?: string; rows: CampaignReportRow[] }

async function main(): Promise<void> {
  const ads = new AdsApiClient(env.adsApi);
  const store =
    process.env.ADS_STORE !== "file" && env.supabase.url && env.supabase.serviceRoleKey
      ? createSupabaseAdsReportStore(env.supabase.url, env.supabase.serviceRoleKey)
      : createFileAdsReportStore(path.resolve(process.cwd(), "data/ads-reports"));
  const today = new Date().toISOString();
  const profiles = (await ads.getProfiles()).filter((p) => COUNTRIES.includes(p.countryCode));
  console.log(`${APPLY ? "APLICANDO" : "SIMULACRO"} · optimizador de presupuesto · ${profiles.map((p) => p.countryCode).join(", ")}`);

  for (const p of profiles) {
    const cc = p.countryCode;
    const profileId = String(p.profileId);
    try {
      const report = await store.readSnapshot<ReportSnapshot>(adsReportKey(profileId, "campaigns"));
      if (!report?.rows?.length) {
        console.warn(`${cc}: sin informe de campañas sincronizado; se ejecuta ads:sync-reports antes`);
        continue;
      }
      const byId = new Map(report.rows.map((r) => [String(r.campaignId), r]));
      const capEnv = Number(process.env[`ADS_OPTIMIZER_BUDGET_${cc}`]);

      const campaigns = (await ads.listSponsoredProductsCampaigns(profileId)).filter(
        (c) => c.name.startsWith(PREFIX) && (c.state ?? "").toUpperCase() === "ENABLED" && byId.has(c.campaignId)
      );
      if (!campaigns.length) {
        console.warn(`${cc}: sin campañas ${PREFIX} activas con informe`);
        continue;
      }

      const metrics: CampaignMetrics[] = campaigns.map((c) => {
        const r = byId.get(c.campaignId) as CampaignReportRow;
        return {
          campaignId: c.campaignId,
          name: c.name,
          budget: Number(c.dailyBudget ?? 0),
          startDate: c.startDate ?? "",
          spend: Number(r.cost ?? 0),
          sales: Number(r.sales7d ?? 0),
          clicks: Number(r.clicks ?? 0),
        };
      });

      // Maduración: lo que el optimizador ajustó hace < 7 días no se toca otra vez.
      const log = (await store.readSnapshot<ChangeLogEntry[]>(changelogKey(profileId))) ?? [];
      const fresh = new Set(
        log
          .filter((e) => e.entityType === "CAMPAIGN_BUDGET" && Date.parse(e.date) > Date.parse(today) - OPTIMIZED_AT * 86_400_000)
          .map((e) => e.entityId.replace("budget:", ""))
      );
      for (const m of metrics) if (fresh.has(m.campaignId)) m.recentlyOptimized = true;

      const cap = Number.isFinite(capEnv) && capEnv > 0 ? capEnv : null;
      const res = rebalanceBudgets(metrics, new Date(), cap);
      const increases = res.changes.filter((c) => c.newBudget > c.oldBudget);
      const cuts = res.changes.filter((c) => c.newBudget < c.oldBudget);
      console.log(
        `${cc}: ${metrics.length} campañas activas · presupuesto ${res.totalBefore.toFixed(2)} → ${res.totalAfter.toFixed(2)} €/día · ${increases.length} subidas, ${cuts.length} recortes, ${res.skipped.length} intactas`
      );
      for (const c of res.changes) console.log(`   ${c.oldBudget.toFixed(2)} → ${c.newBudget.toFixed(2)} €/día · ${c.name} · ${c.reason}`);
      for (const s of res.skipped) console.log(`   (intacta) ${s.name} · ${s.reason}`);
      if (!res.changes.length) continue;

      if (APPLY) {
        const w = ads.writer(profileId);
        await w.put("/sp/campaigns", "application/vnd.spCampaign.v3+json", {
          campaigns: res.changes.map((c) => ({ campaignId: c.campaignId, budget: { budgetType: "DAILY", budget: c.newBudget } })),
        });
        const existing = (await store.readSnapshot<ChangeLogEntry[]>(changelogKey(profileId))) ?? [];
        const entries: ChangeLogEntry[] = res.changes.map((c) => ({
          entityId: `budget:${c.campaignId}`,
          date: today,
          profileId,
          country: cc,
          entityType: "CAMPAIGN_BUDGET",
          text: `Presupuesto ${c.name}: ${c.oldBudget.toFixed(2)} → ${c.newBudget.toFixed(2)} €/día`,
          action: "applied",
          oldValue: `${c.oldBudget.toFixed(2)} €/día`,
          newValue: `${c.newBudget.toFixed(2)} €/día`,
          baselineMetric: res.changes.map((x) => x.reason).join(" · ").slice(0, 300),
          reviewDate: addDays(today, REVIEW_AFTER_DAYS),
          reason: c.reason,
        }));
        await store.writeSnapshot(changelogKey(profileId), appendEntry(existing, ...entries));
        console.log(`   Change Log actualizado (${entries.length} entradas)`);
      }
    } catch (err) {
      console.error(`${cc}: ERROR ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
