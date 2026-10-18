import type { AdvertisedProductReportRow, SearchTermReportRow } from "../../ads/reportTypes";
import type { AdsDataStatus, AdsErrorInfo, AdsInconclusiveReason } from "../../ads/types";
import { loadMarginInputs } from "./adMargins";
import type { AdsReportStore } from "./adsReports.store";
import { type AdvertisingService, toErrorInfo } from "./advertising.service";
import { addDays, appendEntry, type ChangeLogEntry, changelogKey, maturingEntities, REVIEW_AFTER_DAYS } from "./changelog";
import { analyzeHarvest, type HarvestCandidate } from "./harvest";
import {
  ALPHA,
  analyzeNegatives,
  type LeakSummary,
  type NegativeCandidate,
  type NegativeDecision,
  PRIOR_CLICKS,
  type ProposalStatus,
  STOP_LOSS_UNITS,
  withDecisions,
} from "./negatives";

/** Human decisions on keyword proposals (negatives, harvest, high ACoS) of one profile. */
export const keywordDecisionsKey = (profileId: string) => `ads:decisions:keywords:${profileId}`;

type Decided<T> = T & { status: ProposalStatus; decidedAt?: string; maturingUntil?: string };

export interface KeywordHarvestResponse {
  dataStatus: AdsDataStatus;
  inconclusiveReason?: AdsInconclusiveReason;
  profileId?: string;
  country?: string;
  period?: { start: string; end: string };
  reportGeneratedAt?: string;
  negatives?: {
    criteria: { alpha: number; priorClicks: number; stopLossUnits: number };
    summary: LeakSummary;
    proposals: Array<Decided<NegativeCandidate>>;
    insufficient: NegativeCandidate[];
  };
  /** Proceso 3: graduation to exact/product targets and high-ACoS terms. */
  harvest?: Array<Decided<HarvestCandidate>>;
  message?: string;
  error?: AdsErrorInfo;
}

export class DecisionError extends Error {
  constructor(
    public readonly statusCode: 400 | 404 | 409,
    message: string
  ) {
    super(message);
  }
}

/**
 * Procesos 2-3: leak report by search term, negative proposals, harvest and high-ACoS control.
 * Proposal mode only — a person approves or rejects each one (recorded in the Change Log);
 * nothing is sent to Amazon from here.
 */
export class NegativesService {
  constructor(
    private readonly advertising: AdvertisingService,
    private readonly store?: AdsReportStore
  ) {}

  async getKeywordHarvest(country?: string, now = new Date()): Promise<KeywordHarvestResponse> {
    const status = await this.advertising.getConnectionStatus(country);
    if (!status.isConnected || !status.profileId) {
      return { dataStatus: "inconclusive", inconclusiveReason: status.isConfigured ? "connection_error" : "not_configured", error: status.error };
    }
    const profileId = status.profileId;
    const meta = { profileId, country: status.profile?.countryCode };
    if (!this.store) return { ...meta, dataStatus: "inconclusive", inconclusiveReason: "no_performance_data" };
    try {
      const [terms, products, margins, decisions, log] = await Promise.all([
        this.store.load<SearchTermReportRow>(profileId, "searchTerms"),
        this.store.load<AdvertisedProductReportRow>(profileId, "advertisedProducts"),
        loadMarginInputs(this.store, profileId, status.profile?.countryCode),
        this.store.readSnapshot<Record<string, NegativeDecision>>(keywordDecisionsKey(profileId)),
        this.store.readSnapshot<ChangeLogEntry[]>(changelogKey(profileId)),
      ]);
      if (!terms || !products) {
        return { ...meta, dataStatus: "inconclusive", inconclusiveReason: "no_performance_data", message: "Faltan los informes de términos de búsqueda o de productos (npm run ads:sync-reports)." };
      }
      const maturing = maturingEntities(log ?? [], now);
      const decide = <T extends { id: string }>(list: T[]): Array<Decided<T>> =>
        withDecisions(list, decisions ?? {}).map((p) => (maturing.has(p.id) ? { ...p, maturingUntil: maturing.get(p.id) } : p));
      const analysis = analyzeNegatives(terms.rows, products.rows, margins);
      return {
        ...meta,
        dataStatus: analysis.summary.zeroSaleTerms > 0 ? "ok" : "inconclusive",
        inconclusiveReason: analysis.summary.zeroSaleTerms > 0 ? undefined : "no_performance_data",
        period: { start: terms.startDate, end: terms.endDate },
        reportGeneratedAt: terms.generatedAt,
        negatives: {
          criteria: { alpha: ALPHA, priorClicks: PRIOR_CLICKS, stopLossUnits: STOP_LOSS_UNITS },
          summary: analysis.summary,
          proposals: decide(analysis.proposals),
          insufficient: analysis.insufficient,
        },
        harvest: decide(analyzeHarvest(terms.rows, products.rows, margins)),
      };
    } catch (err) {
      return { ...meta, dataStatus: "inconclusive", inconclusiveReason: "connection_error", error: toErrorInfo(err) };
    }
  }

  async getChangeLog(country?: string): Promise<{ profileId?: string; entries: ChangeLogEntry[] }> {
    const status = await this.advertising.getConnectionStatus(country);
    if (!status.profileId || !this.store) return { entries: [] };
    return { profileId: status.profileId, entries: (await this.store.readSnapshot<ChangeLogEntry[]>(changelogKey(status.profileId))) ?? [] };
  }

  /** Records a human decision on a current proposal and its Change Log entry (review in 14 days). */
  async decide(id: string, decision: NegativeDecision["decision"], country?: string, now = new Date()) {
    if (decision !== "approved" && decision !== "rejected") throw new DecisionError(400, "decision debe ser 'approved' o 'rejected'");
    const current = await this.getKeywordHarvest(country, now);
    const proposal = [...(current.negatives?.proposals ?? []), ...(current.harvest ?? [])].find((p) => p.id === id);
    if (!proposal || !current.profileId || !this.store) throw new DecisionError(404, `No hay ninguna propuesta vigente con id '${id}'`);
    const profileId = current.profileId;
    const date = now.toISOString();
    const decisions = (await this.store.readSnapshot<Record<string, NegativeDecision>>(keywordDecisionsKey(profileId))) ?? {};
    await this.store.writeSnapshot(keywordDecisionsKey(profileId), { ...decisions, [id]: { decision, decidedAt: date } });
    const log = (await this.store.readSnapshot<ChangeLogEntry[]>(changelogKey(profileId))) ?? [];
    const sales = "sales" in proposal ? `, ${proposal.sales} € ventas, ACoS ${proposal.acos} %` : ", 0 ventas";
    const entry: ChangeLogEntry = {
      entityId: id,
      date,
      profileId,
      country: current.country,
      entityType: proposal.type,
      text: proposal.text,
      action: decision,
      oldValue: null,
      newValue: "suggestedBid" in proposal ? `${proposal.type} @ ${proposal.suggestedBid} €` : proposal.type,
      baselineMetric: `${proposal.clicks} clics, ${proposal.spend} € gasto${sales}`,
      reviewDate: addDays(date, REVIEW_AFTER_DAYS),
      reason: proposal.reason,
    };
    await this.store.writeSnapshot(changelogKey(profileId), appendEntry(log, entry));
    return { ...proposal, status: decision, decidedAt: date };
  }
}
