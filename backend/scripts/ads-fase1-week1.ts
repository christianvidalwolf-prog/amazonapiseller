/**
 * One-off actions of week 1 of the ads audit plan (spec advertising §17.5), approved 2026-11-25:
 *  - pause the "PF | <CC> | MARCA" campaigns (brand searches ≈ 0 € in 30 days);
 *  - pause the IT phrase keyword "zuccheriera" (63 clicks, 0 orders in 30 days).
 * Both go to the Change Log. Simulation unless ADS_APPLY=1. Idempotent.
 *
 *   ADS_STORE=file npm run ads:fase1-week1
 *   ADS_STORE=file ADS_APPLY=1 npm run ads:fase1-week1
 */
import path from "node:path";
import { AdsApiClient } from "../src/ads/adsClient";
import { env } from "../src/config/env";
import { createFileAdsReportStore, createSupabaseAdsReportStore } from "../src/modules/advertising/adsReports.store";
import { addDays, appendEntry, type ChangeLogEntry, changelogKey, REVIEW_AFTER_DAYS } from "../src/modules/advertising/changelog";
import { listAll, MT } from "./lib/ads-structure";
import { PREFIX } from "./lib/ads-proposals";

const APPLY = process.env.ADS_APPLY === "1";
const COUNTRIES = ["ES", "DE", "FR", "IT"];
const KEYWORD_PAUSES: Record<string, Array<{ campaign: string; text: string; matchType: string; why: string }>> = {
  IT: [{ campaign: `${PREFIX} IT | MANUAL | FRASE`, text: "zuccheriera", matchType: "PHRASE", why: "Auditoría 30 d: 63 clics, 8,84 € y 0 pedidos" }],
};

async function main(): Promise<void> {
  const ads = new AdsApiClient(env.adsApi);
  const store =
    process.env.ADS_STORE !== "file" && env.supabase.url && env.supabase.serviceRoleKey
      ? createSupabaseAdsReportStore(env.supabase.url, env.supabase.serviceRoleKey)
      : createFileAdsReportStore(path.resolve(process.cwd(), "data/ads-reports"));
  console.log(`${APPLY ? "APLICANDO" : "SIMULACRO"} · semana 1 del plan de Ads`);
  for (const p of (await ads.getProfiles()).filter((x) => COUNTRIES.includes(x.countryCode))) {
    const cc = p.countryCode;
    const profileId = String(p.profileId);
    const w = ads.writer(profileId);
    let log = (await store.readSnapshot<ChangeLogEntry[]>(changelogKey(profileId))) ?? [];
    const record = (entityId: string, entityType: string, text: string, oldValue: string, newValue: string, reason: string) => {
      const date = new Date().toISOString();
      log = appendEntry(log, { entityId, date, profileId, country: cc, entityType, text, action: "applied", oldValue, newValue, baselineMetric: "—", reviewDate: addDays(date, REVIEW_AFTER_DAYS), reason });
    };
    const campaigns = (await ads.listSponsoredProductsCampaigns(profileId)).filter((c) => c.name.startsWith(PREFIX));

    const brand = campaigns.filter((c) => /\|\s*MARCA$/i.test(c.name) && c.state === "enabled");
    for (const c of brand) {
      console.log(`${cc}: pausar campaña ${c.name} (${c.campaignId})`);
      if (APPLY) await w.put("/sp/campaigns", MT.campaign, { campaigns: [{ campaignId: c.campaignId, state: "PAUSED" }] });
      record(c.campaignId, "CAMPAIGN", c.name, "ENABLED", "PAUSED", "Plan semana 1: búsquedas de marca ≈ 0 € en 30 días, no hay marca que defender");
    }

    for (const k of KEYWORD_PAUSES[cc] ?? []) {
      const campaign = campaigns.find((c) => c.name === k.campaign);
      if (!campaign) continue;
      const keywords = await listAll<{ keywordId: string; keywordText: string; matchType: string }>(w, "/sp/keywords/list", MT.keyword, "keywords", {
        campaignIdFilter: { include: [campaign.campaignId] },
        stateFilter: { include: ["ENABLED"] },
      });
      for (const kw of keywords.filter((x) => x.keywordText.toLowerCase() === k.text && x.matchType === k.matchType)) {
        console.log(`${cc}: pausar keyword «${kw.keywordText}» ${kw.matchType} (${kw.keywordId}) en ${campaign.name}`);
        if (APPLY) await w.put("/sp/keywords", MT.keyword, { keywords: [{ keywordId: kw.keywordId, state: "PAUSED" }] });
        record(kw.keywordId, "KEYWORD", kw.keywordText, "ENABLED", "PAUSED", `Plan semana 1: ${k.why}`);
      }
    }
    if (APPLY) await store.writeSnapshot(changelogKey(profileId), log);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
