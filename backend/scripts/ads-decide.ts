/**
 * Decide on proposals from the daily report right away instead of waiting for the 9:00 run
 * (spec advertising §12). Approved proposals are executed in Amazon and recorded in the Change Log.
 *
 *   npm run ads:decide -- ES-3f9a2c si
 *   npm run ads:decide -- ES-3f9a2c si DE-1b2c3d no
 */
import fs from "node:fs";
import path from "node:path";
import { AdsApiClient } from "../src/ads/adsClient";
import { env } from "../src/config/env";
import { createFileAdsReportStore, createSupabaseAdsReportStore } from "../src/modules/advertising/adsReports.store";
import { parseDecisions } from "../src/modules/advertising/decisions";
import { DECISIONS_FILE, loadProposals, PREFIX, pfStore, processDecisions, REPORTS_DIR } from "./lib/ads-proposals";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pairs: string[] = [];
  for (let i = 0; i + 1 < args.length; i += 2) pairs.push(`${args[i]} ${args[i + 1]}`);
  const { decisions, invalid } = parseDecisions(pairs.join("\n"));
  if (!decisions.length || invalid.length) {
    console.error("Uso: npm run ads:decide -- <código> <si|no> [<código> <si|no> ...]   (ej. ES-3f9a2c si)");
    process.exitCode = 1;
    return;
  }
  const ads = new AdsApiClient(env.adsApi);
  const store =
    process.env.ADS_STORE !== "file" && env.supabase.url && env.supabase.serviceRoleKey
      ? createSupabaseAdsReportStore(env.supabase.url, env.supabase.serviceRoleKey)
      : createFileAdsReportStore(path.resolve(process.cwd(), "data/ads-reports"));
  const countries = [...new Set(decisions.map((d) => d.code.slice(0, 2)))];
  const profiles = (await ads.getProfiles()).filter((p) => countries.includes(p.countryCode));
  const done: string[] = [];
  for (const profile of profiles) {
    const campaigns = (await ads.listSponsoredProductsCampaigns(String(profile.profileId))).filter((c) => c.name.startsWith(PREFIX));
    const pf = pfStore(store, campaigns.map((c) => c.campaignId));
    const proposals = await loadProposals(pf, profile.countryCode);
    for (const o of await processDecisions(ads, pf, profile, campaigns, proposals, decisions, true)) {
      console.log(`${o.code} → ${o.result}`);
      done.push(`# [${new Date().toISOString().slice(0, 10)} ads:decide] ${o.code} ${o.verdict === "approved" ? "SI" : "NO"} → ${o.result}`);
    }
  }
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.appendFileSync(DECISIONS_FILE, `${done.join("\n")}\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
