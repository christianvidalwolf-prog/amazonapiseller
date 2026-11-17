/**
 * Product-level loss guard (spec advertising §11). The regulator works per keyword/target, so a
 * product that loses money across every target keeps being advertised. This pauses the product's
 * ads in the profit-first campaigns when its 30-day profit after ads is clearly negative:
 *   profit after ads ≤ −10 €, ad spend ≥ 8 €, and no ad sales or ACoS > 50 %.
 * After 30 days paused (a clean 30-day window) it is re-enabled once to retest; the regulator has
 * cut its bids meanwhile. If it loses again ≥ 14 days after the retest, it stays paused for good.
 */

export const LOSS_MIN = -10;
export const SPEND_MIN = 8;
export const ACOS_MAX = 50;
export const RETEST_AFTER_DAYS = 30;
export const RETEST_JUDGE_DAYS = 14;
const DAY = 86_400_000;

export interface SkuProfit {
  sku: string;
  spend: number;
  adSales: number;
  profitAfterAds: number | null;
}

export interface ProfitPauseRecord {
  pausedAt: string;
  loss: number;
  resumedAt?: string;
  permanent?: boolean;
}

export type ProfitPauseState = Record<string, ProfitPauseRecord>;

export interface ProfitAd {
  adId: string;
  sku: string;
  state: string;
}

export interface ProfitPauseDecision {
  pause: Array<{ adId: string; sku: string; reason: string }>;
  resume: Array<{ adId: string; sku: string }>;
  next: ProfitPauseState;
}

const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY;

export function losing(p: SkuProfit): string | null {
  if (p.profitAfterAds === null || p.profitAfterAds > LOSS_MIN || p.spend < SPEND_MIN) return null;
  const acos = p.adSales > 0 ? (p.spend / p.adSales) * 100 : Infinity;
  if (acos <= ACOS_MAX) return null;
  const sales = p.adSales > 0 ? `ACoS ${Math.round(acos)} %` : "sin ventas por publicidad";
  return `pierde ${Math.abs(p.profitAfterAds).toFixed(2)} € tras publicidad en 30 días (gasto ${p.spend.toFixed(2)} €, ${sales})`;
}

export function profitPause(ads: ProfitAd[], profits: SkuProfit[], state: ProfitPauseState, today: string): ProfitPauseDecision {
  const bySku = new Map(profits.map((p) => [p.sku, p]));
  const next: ProfitPauseState = { ...state };
  const pause: ProfitPauseDecision["pause"] = [];
  const resume: ProfitPauseDecision["resume"] = [];
  const skus = [...new Set(ads.map((a) => a.sku))];
  for (const sku of skus) {
    const own = ads.filter((a) => a.sku === sku);
    const rec = next[sku];
    const enabled = own.filter((a) => a.state.toUpperCase() === "ENABLED");
    if (rec && !rec.resumedAt && !rec.permanent && days(rec.pausedAt, today) >= RETEST_AFTER_DAYS) {
      for (const a of own.filter((x) => x.state.toUpperCase() === "PAUSED")) resume.push({ adId: a.adId, sku });
      next[sku] = { ...rec, resumedAt: today };
      continue;
    }
    if (!enabled.length) continue;
    if (rec?.resumedAt && days(rec.resumedAt, today) < RETEST_JUDGE_DAYS) continue;
    const p = bySku.get(sku);
    const why = p ? losing(p) : null;
    if (!why || !p) continue;
    const permanent = Boolean(rec?.resumedAt);
    for (const a of enabled) pause.push({ adId: a.adId, sku, reason: `${why}${permanent ? " — segunda vez, pausa definitiva" : " — se reintenta en 30 días"}` });
    next[sku] = { pausedAt: today, loss: p.profitAfterAds ?? 0, ...(permanent ? { permanent: true, resumedAt: rec?.resumedAt } : {}) };
  }
  return { pause, resume, next };
}
