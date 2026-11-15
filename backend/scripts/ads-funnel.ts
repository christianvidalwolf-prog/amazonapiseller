/**
 * Fase B del embudo Auto → Frase → Exacta (spec advertising §15): calcula cada día qué búsquedas
 * suben de nivel y qué negativas se pondrían en origen. MODO PRUEBA: no escribe en Amazon; guarda
 * el plan en backend/data/ads-reports/ads_funnel_<profileId>.json e imprime el resumen por país.
 */
import { AdsApiClient } from "../src/ads/adsClient";
import type { SearchTermReportRow } from "../src/ads/reportTypes";
import { env } from "../src/config/env";
import path from "node:path";
import { createFileAdsReportStore } from "../src/modules/advertising/adsReports.store";
import { type Destination, normalize, planFunnel } from "../src/modules/advertising/funnel";
import { PREFIX } from "./lib/ads-proposals";

const COUNTRIES = (process.env.ADS_PLAN_COUNTRIES ?? "ES,DE,FR,IT").split(",").map((c) => c.trim().toUpperCase());
const MT = { keyword: "application/vnd.spKeyword.v3+json", target: "application/vnd.spTargetingClause.v3+json" };
const DEST: Record<Destination, string> = { exact: "EXACTA", phrase: "FRASE", asin: "ASIN" };

type Writer = ReturnType<AdsApiClient["writer"]>;
async function listAll<T>(w: Writer, p: string, mt: string, wrapper: string, filter: Record<string, unknown>): Promise<T[]> {
  const out: T[] = [];
  let nextToken: string | undefined;
  do {
    const res = await w.post<Record<string, unknown> & { nextToken?: string }>(p, mt, { ...filter, maxResults: 1000, ...(nextToken ? { nextToken } : {}) });
    out.push(...((res[wrapper] as T[]) ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

async function main(): Promise<void> {
  const ads = new AdsApiClient(env.adsApi);
  const store = createFileAdsReportStore(path.resolve(process.cwd(), "data", "ads-reports"));
  const profiles = (await ads.getProfiles()).filter((p) => COUNTRIES.includes(p.countryCode));
  console.log(`EMBUDO (modo prueba, sin cambios en Amazon) · ${profiles.map((p) => p.countryCode).join(", ")}`);
  for (const p of profiles) {
    const cc = p.countryCode;
    const profileId = String(p.profileId);
    const w = ads.writer(profileId);
    const campaigns = (await ads.listSponsoredProductsCampaigns(profileId)).filter((c) => c.name.startsWith(PREFIX));
    const names = new Map(campaigns.map((c) => [c.campaignId, c.name]));
    const ids = [...names.keys()];
    const rows = ((await store.load<SearchTermReportRow>(profileId, "searchTerms"))?.rows ?? []).filter((r) => names.has(String(r.campaignId)));
    const keywords = await listAll<{ keywordText: string; matchType: string }>(w, "/sp/keywords/list", MT.keyword, "keywords", { campaignIdFilter: { include: ids }, stateFilter: { include: ["ENABLED", "PAUSED"] } });
    const targets = await listAll<{ expression?: Array<{ type: string; value?: string }> }>(w, "/sp/targets/list", MT.target, "targetingClauses", { campaignIdFilter: { include: ids }, stateFilter: { include: ["ENABLED", "PAUSED"] } });
    const live: Record<Destination, Set<string>> = {
      exact: new Set(keywords.filter((k) => k.matchType === "EXACT").map((k) => normalize(k.keywordText))),
      phrase: new Set(keywords.filter((k) => k.matchType === "PHRASE").map((k) => normalize(k.keywordText))),
      asin: new Set(targets.flatMap((t) => (t.expression ?? []).filter((e) => e.type === "ASIN_SAME_AS" && e.value).map((e) => normalize(String(e.value))))),
    };
    const plan = planFunnel(rows, names, live);
    await store.writeSnapshot(`ads:funnel:${profileId}`, { generatedAt: new Date().toISOString(), mode: "dry-run", promotions: plan });
    console.log(`${cc}: ${plan.length} subidas de nivel (${rows.length} búsquedas analizadas)`);
    for (const x of plan) {
      const negs = x.origins.map((o) => o.campaignName.replace(`${PREFIX} ${cc} | `, "")).join(", ");
      console.log(`   → ${DEST[x.to]} «${x.term}» puja ${x.bid} € · ${x.rule} · ventas ${x.sales} € · negativa en: ${negs}`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
