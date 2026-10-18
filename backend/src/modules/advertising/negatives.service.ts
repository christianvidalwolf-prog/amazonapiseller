import type { AdvertisedProductReportRow, SearchTermReportRow } from "../../ads/reportTypes";
import type { AdsDataStatus, AdsErrorInfo, AdsInconclusiveReason } from "../../ads/types";
import { loadMarginInputs } from "./adMargins";
import type { AdsReportStore } from "./adsReports.store";
import { type AdvertisingService, toErrorInfo } from "./advertising.service";
import {
  ALPHA,
  analyzeNegatives,
  type LeakSummary,
  type NegativeCandidate,
  type NegativeDecision,
  type NegativeProposal,
  PRIOR_CLICKS,
  withDecisions,
} from "./negatives";

export const negativeDecisionsKey = (profileId: string) => `ads:decisions:negatives:${profileId}`;

export interface KeywordHarvestResponse {
  dataStatus: AdsDataStatus;
  inconclusiveReason?: AdsInconclusiveReason;
  profileId?: string;
  period?: { start: string; end: string };
  reportGeneratedAt?: string;
  negatives?: {
    criteria: { alpha: number; priorClicks: number };
    summary: LeakSummary;
    proposals: NegativeProposal[];
    insufficient: NegativeCandidate[];
  };
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
 * Proceso 2: leak report by search term + negative proposals. Proposal mode only —
 * a person approves or rejects each one; nothing is sent to Amazon from here.
 */
export class NegativesService {
  constructor(
    private readonly advertising: AdvertisingService,
    private readonly store?: AdsReportStore
  ) {}

  async getKeywordHarvest(country?: string): Promise<KeywordHarvestResponse> {
    const status = await this.advertising.getConnectionStatus(country);
    if (!status.isConnected || !status.profileId) {
      return { dataStatus: "inconclusive", inconclusiveReason: status.isConfigured ? "connection_error" : "not_configured", error: status.error };
    }
    const profileId = status.profileId;
    if (!this.store) return { dataStatus: "inconclusive", inconclusiveReason: "no_performance_data", profileId };
    try {
      const [terms, products, margins, decisions] = await Promise.all([
        this.store.load<SearchTermReportRow>(profileId, "searchTerms"),
        this.store.load<AdvertisedProductReportRow>(profileId, "advertisedProducts"),
        loadMarginInputs(this.store, profileId, status.profile?.countryCode),
        this.store.readSnapshot<Record<string, NegativeDecision>>(negativeDecisionsKey(profileId)),
      ]);
      if (!terms || !products) {
        return { dataStatus: "inconclusive", inconclusiveReason: "no_performance_data", profileId, message: "Faltan los informes de términos de búsqueda o de productos (npm run ads:sync-reports)." };
      }
      const analysis = analyzeNegatives(terms.rows, products.rows, margins);
      return {
        dataStatus: analysis.summary.zeroSaleTerms > 0 ? "ok" : "inconclusive",
        inconclusiveReason: analysis.summary.zeroSaleTerms > 0 ? undefined : "no_performance_data",
        profileId,
        period: { start: terms.startDate, end: terms.endDate },
        reportGeneratedAt: terms.generatedAt,
        negatives: {
          criteria: { alpha: ALPHA, priorClicks: PRIOR_CLICKS },
          summary: analysis.summary,
          proposals: withDecisions(analysis.proposals, decisions ?? {}),
          insufficient: analysis.insufficient,
        },
      };
    } catch (err) {
      return { dataStatus: "inconclusive", inconclusiveReason: "connection_error", profileId, error: toErrorInfo(err) };
    }
  }

  /** Records a human decision on a current proposal (audit: who decided is the authenticated panel; when, here). */
  async decide(id: string, decision: NegativeDecision["decision"], country?: string, now = new Date()): Promise<NegativeProposal> {
    if (decision !== "approved" && decision !== "rejected") throw new DecisionError(400, "decision debe ser 'approved' o 'rejected'");
    const harvest = await this.getKeywordHarvest(country);
    const proposal = harvest.negatives?.proposals.find((p) => p.id === id);
    if (!proposal || !harvest.profileId || !this.store) throw new DecisionError(404, `No hay ninguna propuesta vigente con id '${id}'`);
    const key = negativeDecisionsKey(harvest.profileId);
    const decisions = (await this.store.readSnapshot<Record<string, NegativeDecision>>(key)) ?? {};
    const record: NegativeDecision = { decision, decidedAt: now.toISOString() };
    await this.store.writeSnapshot(key, { ...decisions, [id]: record });
    return { ...proposal, status: decision, decidedAt: record.decidedAt };
  }
}
