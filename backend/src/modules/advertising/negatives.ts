import type { AdvertisedProductReportRow, SearchTermReportRow } from "../../ads/reportTypes";
import { type MarginInput, unitProfitBeforeAds } from "./profitability";

/**
 * Proceso 2 — fuga por términos de búsqueda y negativas en modo propuesta (spec advertising §7).
 *
 * A search term with spend and no sales is proposed as a negative only when
 *  (a) with the ad group's conversion rate, getting 0 orders in that many clicks
 *      by chance is unlikely: P(0 | n, cvr) = (1 − cvr)^n < ALPHA, and
 *  (b) its spend already exceeds the profit of one unit of what the ad group sells.
 * Or, as a stop-loss without statistical significance (skill rule 4.2): its spend reached
 * 1.5 × the profit of one unit while at least one sale was already expected (clicks × cvr ≥ 1).
 * Otherwise the term is "insufficient" — never "negate" by default. Nothing here
 * touches Amazon: proposals wait for a human decision.
 */

export const ALPHA = 0.05;
/** Pseudo-clicks of the account conversion rate blended into each ad group's rate (shrinkage). */
export const PRIOR_CLICKS = 50;
/** Stop-loss: spend ≥ this × unit profit with ≥ 1 expected order and no sale. */
export const STOP_LOSS_UNITS = 1.5;
const INSUFFICIENT_LIMIT = 50;
const ASIN_TERM = /^b0[a-z0-9]{8}$/i;

export type NegativeType = "NEGATIVE_EXACT" | "NEGATIVE_PRODUCT_TARGET";
export type ProposalStatus = "proposed" | "approved" | "rejected";

export interface NegativeCandidate {
  /** Stable across runs: adGroupId|type|text. */
  id: string;
  type: NegativeType;
  /** Keyword text, or the ASIN for product targets. */
  text: string;
  campaignId: string;
  adGroupId: string;
  clicks: number;
  impressions: number;
  spend: number;
  /** Smoothed orders per click of the ad group. */
  baselineCvr: number;
  /** Probability of seeing 0 orders in `clicks` if the term converted like its ad group. */
  pNoSale: number;
  /** Click-weighted profit of one unit of the ad group's SKUs (before ads). */
  unitProfit: number | null;
  rule: "statistical" | "stop_loss" | "insufficient";
  reason: string;
}

export interface NegativeProposal extends NegativeCandidate {
  status: ProposalStatus;
  decidedAt?: string;
}

export interface NegativeDecision {
  decision: Exclude<ProposalStatus, "proposed">;
  decidedAt: string;
}

export interface LeakSummary {
  /** Search terms with spend and no attributed order in the window. */
  zeroSaleTerms: number;
  zeroSaleSpend: number;
  proposed: number;
  proposedSpend: number;
  insufficient: number;
  insufficientSpend: number;
  /** Terms of ad groups without any known product cost (guardrail: outside automation). */
  noCost: number;
  noCostSpend: number;
  accountCvr: number;
}

export interface NegativeAnalysis {
  summary: LeakSummary;
  proposals: NegativeCandidate[];
  /** Top insufficient terms by spend (the rest is only counted). */
  insufficient: NegativeCandidate[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export interface AdGroupBaseline {
  cvr: number;
  /** Click-weighted profit of one unit of the group's SKUs (before ads). */
  unitProfit: number | null;
  /** Click-weighted break-even ACoS (%) of the group's SKUs (profit / price with VAT); ≤ 100. */
  breakEvenAcos: number | null;
}

/** Click-weighted mean of a per-SKU value; plain mean when no SKU with a value got clicks. */
class WeightedMean {
  private weight = 0;
  private sum = 0;
  private values: number[] = [];
  add(value: number | null, clicks: number): void {
    if (value === null) return;
    this.sum += value * clicks;
    this.weight += clicks;
    this.values.push(value);
  }
  get value(): number | null {
    if (this.weight > 0) return round2(this.sum / this.weight);
    return this.values.length ? round2(this.values.reduce((a, v) => a + v, 0) / this.values.length) : null;
  }
}

export function adGroupBaselines(products: AdvertisedProductReportRow[], margins: MarginInput[]): { byGroup: Map<string, AdGroupBaseline>; accountCvr: number } {
  const bySku = new Map(
    margins.map((m) => {
      const profit = unitProfitBeforeAds(m);
      const breakEven = profit !== null && m.price ? (Math.max(0, profit) / m.price) * 100 : null;
      return [m.sku.trim().toUpperCase(), { profit, breakEven }];
    })
  );
  const totalClicks = products.reduce((a, r) => a + num(r.clicks), 0);
  const accountCvr = totalClicks > 0 ? products.reduce((a, r) => a + num(r.purchases7d), 0) / totalClicks : 0;

  const groups = new Map<string, { clicks: number; orders: number; profit: WeightedMean; breakEven: WeightedMean }>();
  for (const r of products) {
    const id = String(r.adGroupId ?? "");
    const g = groups.get(id) ?? { clicks: 0, orders: 0, profit: new WeightedMean(), breakEven: new WeightedMean() };
    const sku = bySku.get(String(r.advertisedSku ?? "").trim().toUpperCase());
    const clicks = num(r.clicks);
    g.profit.add(sku?.profit ?? null, clicks);
    g.breakEven.add(sku?.breakEven ?? null, clicks);
    groups.set(id, { ...g, clicks: g.clicks + clicks, orders: g.orders + num(r.purchases7d) });
  }

  const byGroup = new Map<string, AdGroupBaseline>();
  for (const [id, g] of groups) {
    byGroup.set(id, {
      cvr: (g.orders + PRIOR_CLICKS * accountCvr) / (g.clicks + PRIOR_CLICKS),
      unitProfit: g.profit.value,
      breakEvenAcos: g.breakEven.value,
    });
  }
  return { byGroup, accountCvr };
}

export interface TermAccumulator {
  campaignId: string;
  adGroupId: string;
  term: string;
  clicks: number;
  impressions: number;
  spend: number;
  orders: number;
}

/** Same term in the same ad group (reached through several targets) is one candidate. */
export function aggregateTerms(rows: SearchTermReportRow[]): TermAccumulator[] {
  const byKey = new Map<string, TermAccumulator>();
  for (const r of rows) {
    const term = String(r.searchTerm ?? "").trim().toLowerCase();
    if (!term) continue;
    const adGroupId = String(r.adGroupId ?? "");
    const key = `${adGroupId}|${term}`;
    const prev = byKey.get(key) ?? { campaignId: String(r.campaignId ?? ""), adGroupId, term, clicks: 0, impressions: 0, spend: 0, orders: 0 };
    byKey.set(key, {
      ...prev,
      clicks: prev.clicks + num(r.clicks),
      impressions: prev.impressions + num(r.impressions),
      spend: prev.spend + num(r.cost),
      orders: prev.orders + num(r.purchases7d),
    });
  }
  return [...byKey.values()];
}

function toCandidate(t: TermAccumulator, baseline: AdGroupBaseline): NegativeCandidate {
  const isAsin = ASIN_TERM.test(t.term);
  const type: NegativeType = isAsin ? "NEGATIVE_PRODUCT_TARGET" : "NEGATIVE_EXACT";
  const text = isAsin ? t.term.toUpperCase() : t.term;
  const pNoSale = (1 - baseline.cvr) ** t.clicks;
  const spend = round2(t.spend);
  const confident = pNoSale < ALPHA;
  const costly = baseline.unitProfit !== null && spend > baseline.unitProfit;
  const stopLoss = baseline.unitProfit !== null && spend >= STOP_LOSS_UNITS * baseline.unitProfit && t.clicks * baseline.cvr >= 1;
  const pct = (p: number) => `${(p * 100).toFixed(1)} %`;
  const rule: NegativeCandidate["rule"] = confident && costly ? "statistical" : stopLoss ? "stop_loss" : "insufficient";
  const reason =
    rule === "statistical"
      ? `${t.clicks} clics sin venta: con la conversión del grupo (${pct(baseline.cvr)}) solo habría un ${pct(pNoSale)} de probabilidad; gasto ${spend} € > beneficio de una unidad (${baseline.unitProfit} €)`
      : rule === "stop_loss"
        ? `Stop-loss: ${spend} € gastados sin venta ≥ ${STOP_LOSS_UNITS} × beneficio de una unidad (${baseline.unitProfit} €) y ya se esperaba ${(t.clicks * baseline.cvr).toFixed(1)} venta(s)`
        : !confident
          ? `Evidencia insuficiente: ${t.clicks} clics, probabilidad de 0 ventas por azar ${pct(pNoSale)} (≥ ${pct(ALPHA)})`
          : `Gasto ${spend} € aún no supera el beneficio de una unidad (${baseline.unitProfit} €)`;
  return {
    id: `${t.adGroupId}|${type}|${text}`,
    type,
    text,
    campaignId: t.campaignId,
    adGroupId: t.adGroupId,
    clicks: t.clicks,
    impressions: t.impressions,
    spend,
    baselineCvr: Math.round(baseline.cvr * 10_000) / 10_000,
    pNoSale: Math.round(pNoSale * 10_000) / 10_000,
    unitProfit: baseline.unitProfit,
    rule,
    reason,
  };
}

export function analyzeNegatives(
  searchTerms: SearchTermReportRow[],
  products: AdvertisedProductReportRow[],
  margins: MarginInput[]
): NegativeAnalysis {
  const { byGroup, accountCvr } = adGroupBaselines(products, margins);
  const zeroSale = aggregateTerms(searchTerms).filter((t) => t.orders === 0 && t.spend > 0);

  const proposals: NegativeCandidate[] = [];
  const insufficient: NegativeCandidate[] = [];
  let noCost = 0;
  let noCostSpend = 0;
  for (const t of zeroSale) {
    const baseline = byGroup.get(t.adGroupId) ?? { cvr: accountCvr, unitProfit: null, breakEvenAcos: null };
    if (baseline.unitProfit === null) {
      noCost += 1;
      noCostSpend += t.spend;
      continue;
    }
    const candidate = toCandidate(t, baseline);
    (candidate.rule === "insufficient" ? insufficient : proposals).push(candidate);
  }

  const bySpend = (a: NegativeCandidate, b: NegativeCandidate) => b.spend - a.spend;
  const sum = (list: Array<{ spend: number }>) => round2(list.reduce((a, c) => a + c.spend, 0));
  return {
    summary: {
      zeroSaleTerms: zeroSale.length,
      zeroSaleSpend: sum(zeroSale),
      proposed: proposals.length,
      proposedSpend: sum(proposals),
      insufficient: insufficient.length,
      insufficientSpend: sum(insufficient),
      noCost,
      noCostSpend: round2(noCostSpend),
      accountCvr: Math.round(accountCvr * 10_000) / 10_000,
    },
    proposals: proposals.sort(bySpend),
    insufficient: insufficient.sort(bySpend).slice(0, INSUFFICIENT_LIMIT),
  };
}

/** Human decisions survive regeneration: a proposal keeps its status while its id exists. */
export function withDecisions<T extends { id: string }>(
  candidates: T[],
  decisions: Record<string, NegativeDecision>
): Array<T & { status: ProposalStatus; decidedAt?: string }> {
  return candidates.map((c) => {
    const d = decisions[c.id];
    return d ? { ...c, status: d.decision, decidedAt: d.decidedAt } : { ...c, status: "proposed" as const };
  });
}
