/**
 * Sustainable CPC per SKU (spec advertising §9): Max_CPC = revenue per click × Target_ACoS × alpha,
 * with Target_ACoS = 65 % of the break-even ACoS (maturity phase, 60-70 %). Bids in Amazon live on
 * keywords/targets/ad groups, not SKUs: this tells which SKUs to pull out or which bid tier
 * they belong to. Proposal only — raises capped at +20 % and 1,50 €; cuts are free.
 */

export const TARGET_ACOS_SHARE = 0.65;
export const MIN_CLICKS_FOR_BID = 15;
export const MAX_CPC = 1.5;
export const MAX_RAISE = 0.2;
const TOLERANCE = 0.05;

export type BidAction = "pausar" | "bajar" | "subir" | "mantener" | "sin_datos";

export interface BidAdviceInput {
  clicks: number;
  spend: number;
  /** Same-SKU attributed sales (conservative revenue per click). */
  sameSkuSales: number;
  breakEvenAcos: number | null;
  alpha: number;
}

export interface BidAdvice {
  targetAcos: number | null;
  cpc: number | null;
  maxCpc: number | null;
  suggestedCpc: number | null;
  bidAction: BidAction | null;
  bidReason?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function bidAdvice(input: BidAdviceInput): BidAdvice {
  const targetAcos = input.breakEvenAcos === null ? null : round2(input.breakEvenAcos * TARGET_ACOS_SHARE);
  const cpc = input.clicks > 0 ? round2(input.spend / input.clicks) : null;
  const empty = { targetAcos, cpc, maxCpc: null, suggestedCpc: null };
  if (input.alpha === 0) return { ...empty, suggestedCpc: 0, bidAction: "pausar", bidReason: "Sin Buy Box o sin stock: no anunciar" };
  if (targetAcos === null) return { ...empty, bidAction: null };
  if (input.clicks < MIN_CLICKS_FOR_BID) {
    return { ...empty, bidAction: "sin_datos", bidReason: `Menos de ${MIN_CLICKS_FOR_BID} clics en la ventana` };
  }
  const revenuePerClick = input.sameSkuSales / input.clicks;
  const maxCpc = round2(Math.min(MAX_CPC, revenuePerClick * (targetAcos / 100) * input.alpha));
  if (cpc !== null && maxCpc < cpc * (1 - TOLERANCE)) {
    return { targetAcos, cpc, maxCpc, suggestedCpc: maxCpc, bidAction: "bajar", bidReason: `CPC ${cpc} € > sostenible ${maxCpc} €` };
  }
  if (cpc !== null && maxCpc > cpc * (1 + TOLERANCE)) {
    const suggestedCpc = round2(Math.min(maxCpc, cpc * (1 + MAX_RAISE)));
    return { targetAcos, cpc, maxCpc, suggestedCpc, bidAction: "subir", bidReason: `Margen para pujar más (máx. +20 % por cambio)` };
  }
  return { targetAcos, cpc, maxCpc, suggestedCpc: cpc, bidAction: "mantener" };
}
