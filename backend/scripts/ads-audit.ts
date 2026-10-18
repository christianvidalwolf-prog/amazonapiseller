/**
 * Weekly Amazon Ads audit (skill amazon-ads-spapi-optimizer, spec advertising §9): the 5 sections
 * per country from the stored reports, margins and stock/Buy Box context. Read-only — writes a
 * markdown file and prints it; nothing is changed in Amazon.
 *
 *   npm run ads:audit                         # ES, DE, FR, IT
 *   ADS_AUDIT_COUNTRIES=ES,FR npm run ads:audit
 */
import fs from "node:fs";
import path from "node:path";
import { AdsApiClient } from "../src/ads/adsClient";
import { env } from "../src/config/env";
import { createFileAdsReportStore, createSupabaseAdsReportStore } from "../src/modules/advertising/adsReports.store";
import { AdvertisingService } from "../src/modules/advertising/advertising.service";
import { buildCountryAudit } from "../src/modules/advertising/audit";
import { NegativesService } from "../src/modules/advertising/negatives.service";
import { SalesService } from "../src/modules/sales/sales.service";
import { SpApiClient } from "../src/spapi/client";

const COUNTRIES = (process.env.ADS_AUDIT_COUNTRIES ?? "ES,DE,FR,IT").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);

async function main(): Promise<void> {
  const store =
    env.supabase.url && env.supabase.serviceRoleKey
      ? createSupabaseAdsReportStore(env.supabase.url, env.supabase.serviceRoleKey)
      : createFileAdsReportStore(path.resolve(process.cwd(), "data/ads-reports"));
  const sales = new SalesService(new SpApiClient({ credentials: env.spApi }), env.marketplaceIds);
  const advertising = new AdvertisingService(new AdsApiClient(env.adsApi), env.marketplaceIds[0], undefined, {
    reports: store,
    storeSales: async (start, end, channel) =>
      (await sales.getSalesSummary(`${start}T00:00:00Z`, `${end}T23:59:59Z`)).byChannel.find((c) => c.channel === channel)?.revenue ?? null,
  });
  const keywords = new NegativesService(advertising, store);
  const today = new Date().toISOString().slice(0, 10);

  const sections: string[] = [`# Auditoría Amazon Ads · ${today}`, "_Modo propuesta: nada se ha cambiado en Amazon. Aprobar en el panel antes de aplicar._"];
  for (const country of COUNTRIES) {
    const [summary, campaigns, profitability, kw] = await Promise.all([
      advertising.getSummary(country),
      advertising.getCampaigns(country),
      advertising.getProfitability(country),
      keywords.getKeywordHarvest(country),
    ]);
    sections.push(buildCountryAudit({ country, summary, campaigns: campaigns.campaigns, profitability, keywords: kw }, today).markdown);
  }
  const markdown = sections.join("\n\n");
  const file = path.resolve(process.cwd(), `data/ads-audit-${today}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, markdown);
  console.log(markdown);
  console.log(`\nGuardado en ${file}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
