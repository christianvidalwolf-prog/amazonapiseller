/**
 * Fase A del embudo Auto → Frase → Exacta: crea en cada país la campaña
 * "PF | <CC> | MANUAL | FRASE" (manual, PAUSADA) con un grupo de anuncios "Frase".
 * Sin keywords ni anuncios: la cosecha (Fase B) los añade cuando una búsqueda de Auto da señal.
 * Idempotente (no duplica si ya existe). Simulacro por defecto; ADS_APPLY=1 escribe en Amazon.
 */
import { AdsApiClient } from "../src/ads/adsClient";
import { env } from "../src/config/env";
import { PREFIX } from "./lib/ads-proposals";

const COUNTRIES = (process.env.ADS_PLAN_COUNTRIES ?? "ES,DE,FR,IT").split(",").map((c) => c.trim().toUpperCase());
const APPLY = process.env.ADS_APPLY === "1";
/** Starting budget per country (€/day); the budget optimizer moves it once the campaign has data. */
const BUDGET: Record<string, number> = { ES: 3, DE: 2, FR: 2, IT: 1.5 };
const DEFAULT_BID = 0.3;
const MT = { campaign: "application/vnd.spCampaign.v3+json", adGroup: "application/vnd.spAdGroup.v3+json" };

type MultiStatus = { success?: Array<{ index: number; campaignId?: string; adGroupId?: string }>; error?: Array<{ index: number; errors?: unknown }> };

async function main(): Promise<void> {
  const ads = new AdsApiClient(env.adsApi);
  const profiles = (await ads.getProfiles()).filter((p) => COUNTRIES.includes(p.countryCode));
  const startDate = new Date().toISOString().slice(0, 10);
  console.log(`${APPLY ? "APLICANDO" : "SIMULACRO"} · campañas FRASE · ${profiles.map((p) => p.countryCode).join(", ")}`);
  for (const p of profiles) {
    const cc = p.countryCode;
    const profileId = String(p.profileId);
    const name = `${PREFIX} ${cc} | MANUAL | FRASE`;
    const existing = (await ads.listSponsoredProductsCampaigns(profileId)).find((c) => c.name === name);
    if (existing) {
      console.log(`${cc}: ya existe ${name} (${existing.campaignId}, ${existing.state})`);
      continue;
    }
    if (!APPLY) {
      console.log(`${cc}: crearía ${name} · PAUSADA · ${BUDGET[cc] ?? 2} €/día · grupo "Frase" puja ${DEFAULT_BID} €`);
      continue;
    }
    const w = ads.writer(profileId);
    const res = await w.post<{ campaigns?: MultiStatus }>("/sp/campaigns", MT.campaign, {
      campaigns: [{ name, targetingType: "MANUAL", state: "PAUSED", dynamicBidding: { strategy: "LEGACY_FOR_SALES" }, budget: { budgetType: "DAILY", budget: BUDGET[cc] ?? 2 }, startDate }],
    });
    const campaignId = res.campaigns?.success?.[0]?.campaignId;
    if (!campaignId) {
      console.log(`${cc}: ERROR al crear ${name}: ${JSON.stringify(res.campaigns?.error ?? res)}`);
      process.exitCode = 1;
      continue;
    }
    const ag = await w.post<{ adGroups?: MultiStatus }>("/sp/adGroups", MT.adGroup, { adGroups: [{ campaignId: String(campaignId), name: "Frase", state: "ENABLED", defaultBid: DEFAULT_BID }] });
    const adGroupId = ag.adGroups?.success?.[0]?.adGroupId;
    console.log(`${cc}: creada ${name} (${campaignId}) PAUSADA${adGroupId ? ` · grupo Frase ${adGroupId}` : ` · ERROR grupo: ${JSON.stringify(ag.adGroups?.error ?? ag)}`}`);
    if (!adGroupId) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
