/**
 * Proposals of the profit-first campaigns and the user's decisions on them (spec advertising §12),
 * shared by the daily control (ads:daily) and the immediate decision command (ads:decide).
 */
import fs from "node:fs";
import path from "node:path";
import type { AdsApiClient } from "../../src/ads/adsClient";
import type { AdvertisedProductReportRow } from "../../src/ads/reportTypes";
import type { AdsProfile } from "../../src/ads/types";
import { env } from "../../src/config/env";
import type { AdsReportStore } from "../../src/modules/advertising/adsReports.store";
import { AdvertisingService } from "../../src/modules/advertising/advertising.service";
import { addDays, appendEntry, type ChangeLogEntry, changelogKey, REVIEW_AFTER_DAYS } from "../../src/modules/advertising/changelog";
import { DECISIONS_TEMPLATE, markProcessed, type ParsedDecision, parseDecisions, proposalCode } from "../../src/modules/advertising/decisions";
import { NegativesService } from "../../src/modules/advertising/negatives.service";
import { type ApprovedProposal, applyProposal } from "../../src/modules/advertising/proposalApply";

export const PREFIX = "PF |";
export const REPORTS_DIR = path.resolve(process.cwd(), "..", "informes-ads");
export const DECISIONS_FILE = path.join(REPORTS_DIR, "decisiones.txt");

const ACTION: Record<string, string> = {
  NEGATIVE_EXACT: "Negar la búsqueda (negativa exacta)",
  NEGATIVE_PRODUCT_TARGET: "Excluir el ASIN (producto negativo)",
  HARVEST_EXACT: "Graduar a campaña EXACTA",
  HARVEST_PRODUCT_TARGET: "Graduar a campaña ASIN",
  NEGATIVE_EXACT_ORIGIN: "Negar en la campaña automática (ACoS alto)",
  BID_DOWN: "Bajar la puja (ACoS alto)",
};

/** The store, with every report restricted to the profit-first campaigns of the profile. */
export function pfStore(store: AdsReportStore, campaignIds: string[]): AdsReportStore {
  const ids = new Set(campaignIds);
  return {
    ...store,
    load: async <T>(profileId: string, kind: Parameters<AdsReportStore["load"]>[1]) => {
      const report = await store.load<T>(profileId, kind);
      return report ? { ...report, rows: report.rows.filter((r) => ids.has(String((r as { campaignId?: unknown }).campaignId))) } : null;
    },
  };
}

export interface CountryProposals {
  service: NegativesService;
  advertising: AdvertisingService;
  pending: Array<{ code: string; proposal: ApprovedProposal; action: string }>;
  all: Map<string, ApprovedProposal & { status: string }>;
}

export async function loadProposals(store: AdsReportStore, country: string): Promise<CountryProposals> {
  const advertising = new AdvertisingService(new (await import("../../src/ads/adsClient")).AdsApiClient(env.adsApi), env.marketplaceIds[0], undefined, { reports: store });
  const service = new NegativesService(advertising, store);
  const harvest = await service.getKeywordHarvest(country);
  const list = [...(harvest.negatives?.proposals ?? []), ...(harvest.harvest ?? [])] as Array<ApprovedProposal & { status: string; maturingUntil?: string }>;
  const all = new Map(list.map((p) => [proposalCode(country, p.id), p]));
  const pending = [...all]
    .filter(([, p]) => p.status === "proposed" && !p.maturingUntil)
    .map(([code, proposal]) => ({ code, proposal, action: ACTION[proposal.type] ?? proposal.type }));
  return { service, advertising, pending, all };
}

/** SKUs to advertise for a harvested term: up to 5 of its origin ad group that sold their own units. */
async function sellers(store: AdsReportStore, profileId: string, adGroupId: string): Promise<string[]> {
  const rows = (await store.load<AdvertisedProductReportRow>(profileId, "advertisedProducts"))?.rows ?? [];
  const units = new Map<string, number>();
  for (const r of rows) {
    if (String(r.adGroupId) !== adGroupId || !r.advertisedSku || Number(r.unitsSoldSameSku7d ?? 0) <= 0) continue;
    units.set(r.advertisedSku, (units.get(r.advertisedSku) ?? 0) + Number(r.unitsSoldSameSku7d));
  }
  return [...units].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([sku]) => sku);
}

export interface DecisionOutcome {
  code: string;
  verdict: "approved" | "rejected";
  result: string;
  line: number;
}

/**
 * Records the user's decisions for this country and, when approved and `apply`, executes them in
 * Amazon. Each one is written to the Change Log. Codes that no longer match a pending proposal are
 * reported as expired.
 */
export async function processDecisions(
  ads: AdsApiClient,
  store: AdsReportStore,
  profile: AdsProfile,
  campaigns: Array<{ campaignId: string; name: string }>,
  proposals: CountryProposals,
  decisions: ParsedDecision[],
  apply: boolean
): Promise<DecisionOutcome[]> {
  const cc = profile.countryCode;
  const profileId = String(profile.profileId);
  const out: DecisionOutcome[] = [];
  const mine = decisions.filter((d) => d.code.startsWith(`${cc}-`));
  if (!mine.length) return out;
  const writer = ads.writer(profileId);
  const exactCampaignId = campaigns.find((c) => c.name === `${PREFIX} ${cc} | MANUAL | EXACTA`)?.campaignId;
  const asinCampaignId = campaigns.find((c) => c.name === `${PREFIX} ${cc} | MANUAL | ASIN`)?.campaignId;
  for (const d of mine) {
    const p = proposals.all.get(d.code);
    if (!p) {
      out.push({ ...d, result: "no encontrada: la propuesta ya no está vigente (los datos cambiaron)" });
      continue;
    }
    if (p.status !== "proposed") {
      out.push({ ...d, result: `ya estaba ${p.status === "approved" ? "aprobada" : "rechazada"}` });
      continue;
    }
    await proposals.service.decide(p.id, d.verdict, cc);
    if (d.verdict === "rejected") {
      out.push({ ...d, result: "rechazada: no se aplica y no se volverá a proponer" });
      continue;
    }
    if (!apply) {
      out.push({ ...d, result: "aprobada (modo informe: no se ha aplicado)" });
      continue;
    }
    try {
      const harvestType = p.type === "HARVEST_EXACT" || p.type === "HARVEST_PRODUCT_TARGET";
      const result = await applyProposal(writer, p, { exactCampaignId, asinCampaignId, sellers: harvestType ? await sellers(store, profileId, p.adGroupId) : [] });
      const date = new Date().toISOString();
      const log = (await store.readSnapshot<ChangeLogEntry[]>(changelogKey(profileId))) ?? [];
      await store.writeSnapshot(
        changelogKey(profileId),
        appendEntry(log, { entityId: p.id, date, profileId, country: cc, entityType: p.type, text: p.text, action: "applied", oldValue: null, newValue: result, baselineMetric: `${p.clicks} clics, ${p.spend} € gasto`, reviewDate: addDays(date, REVIEW_AFTER_DAYS), reason: p.reason })
      );
      out.push({ ...d, result: `aplicada en Amazon — ${result}` });
    } catch (err) {
      out.push({ ...d, result: `aprobada pero NO aplicada: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return out;
}

export function readDecisionsFile(): { text: string; parsed: ReturnType<typeof parseDecisions> } {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  if (!fs.existsSync(DECISIONS_FILE)) fs.writeFileSync(DECISIONS_FILE, DECISIONS_TEMPLATE);
  const text = fs.readFileSync(DECISIONS_FILE, "utf8");
  return { text, parsed: parseDecisions(text) };
}

export function writeProcessed(text: string, outcomes: DecisionOutcome[], date: string): void {
  const processed = new Map(outcomes.map((o) => [o.line, o.result.split(":")[0].split(" — ")[0]]));
  fs.writeFileSync(DECISIONS_FILE, markProcessed(text, processed, date));
}
