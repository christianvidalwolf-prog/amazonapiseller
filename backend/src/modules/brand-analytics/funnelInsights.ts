import { classifyFunnel, funnelLeak, funnelRatios } from "./searchFunnel.classifier";
import type { FunnelStatus, SearchQueryMetrics } from "./searchFunnel.types";

/**
 * Brand Analytics funnel insights (spec advertising §15, Fases C-D).
 *
 * Adds up the last weeks of Search Query Performance per (ASIN, search term), classifies where
 * the funnel leaks (impression → click → cart → purchase) and crosses it with the Ads search-term
 * data to produce recommendations:
 *  - scale:     terms where the ASIN converts at least as well as the market and has ≥ 2 purchases,
 *               not yet an exact keyword → the funnel agent promotes them to EXACTA (Fase D);
 *  - listing:   leaks by stage, ranked by the search volume behind the lost share, with the fix;
 *  - opportunity: big searches where the ASIN already sells but barely shows (< 5 % impressions);
 *  - cut:       terms Ads pays for (≥ 2 € without sales) where SQP confirms the ASIN gets clicks
 *               (≥ 10) but no purchases → negative in Ads (Fase D);
 *  - trend:     purchase share of the last week vs the previous ones on the best terms.
 */

export const MIN_WEEKS = 2;
export const SCALE_MIN_PURCHASES = 2;
export const PHRASE_MIN_PURCHASES = 1;
/** Listing leaks per ASIN (all its search terms): minimum sample and how far below the market. */
export const ASIN_MIN_IMPRESSIONS = 300;
export const ASIN_MIN_CLICKS = 20;
export const ASIN_MIN_CARTS = 5;
export const LEAK_FACTOR = 0.5;
export const TERM_MIN_IMPRESSIONS = 100;
export const OPPORTUNITY_MAX_IMPRESSION_SHARE = 0.05;
export const OPPORTUNITY_MIN_VOLUME = 200;
export const CUT_MIN_ADS_SPEND = 2;
export const CUT_MIN_ASIN_CLICKS = 10;

export interface AdsTermStats {
  spend: number;
  sales: number;
  clicks: number;
  orders: number;
  /** Already an enabled/paused exact keyword in the PF campaigns. */
  exactLive: boolean;
}

export interface FunnelInsight {
  asin: string;
  term: string;
  weeks: number;
  status: FunnelStatus;
  volume: number;
  impressionShare: number;
  clickShare: number;
  cartShare: number;
  purchaseShare: number;
  purchases: number;
  ctr: number;
  cartRate: number;
  purchaseRate: number;
  impactScore: number;
  asinPrice: number | null;
  marketPrice: number | null;
  ads?: AdsTermStats;
}

export interface Recommendation {
  kind: "scale" | "listing" | "opportunity" | "cut";
  /** Only for "scale": the funnel level the term should go to. */
  to?: "exact" | "phrase";
  asin: string;
  term: string;
  action: string;
  why: string;
  impact: number;
}

export interface TrendPoint {
  asin: string;
  term: string;
  lastShare: number;
  previousShare: number;
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const pct = (n: number) => `${(n * 100).toFixed(1)} %`;
export const normalizeTerm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");

/** Sums several weeks of one (ASIN, term) into one metrics row with recomputed shares. */
export function aggregateWeeks(rows: SearchQueryMetrics[]): Array<SearchQueryMetrics & { weeks: number }> {
  const groups = new Map<string, SearchQueryMetrics[]>();
  for (const r of rows) {
    const k = `${r.asin}|${normalizeTerm(r.queryText)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: Array<SearchQueryMetrics & { weeks: number }> = [];
  for (const g of groups.values()) {
    const sum = (f: (m: SearchQueryMetrics) => number) => g.reduce((a, m) => a + (f(m) || 0), 0);
    const share = (a: number, b: number) => (b > 0 ? r4(a / b) : 0);
    const totalImpressions = sum((m) => m.totalImpressions);
    const totalClicks = sum((m) => m.totalClicks);
    const totalCartAdds = sum((m) => m.totalCartAdds);
    const totalPurchases = sum((m) => m.totalPurchases);
    const asinImpressions = sum((m) => m.asinImpressions);
    const asinClicks = sum((m) => m.asinClicks);
    const asinCartAdds = sum((m) => m.asinCartAdds);
    const asinPurchases = sum((m) => m.asinPurchases);
    const last = [...g].sort((a, b) => b.periodStart.localeCompare(a.periodStart))[0];
    out.push({
      ...last,
      queryText: normalizeTerm(last.queryText),
      periodStart: g.map((m) => m.periodStart).sort()[0],
      weeks: new Set(g.map((m) => m.periodStart)).size,
      totalQueryVolume: sum((m) => m.totalQueryVolume),
      totalImpressions,
      totalClicks,
      totalCartAdds,
      totalPurchases,
      asinImpressions,
      asinClicks,
      asinCartAdds,
      asinPurchases,
      asinImpressionShare: share(asinImpressions, totalImpressions),
      asinClickShare: share(asinClicks, totalClicks),
      asinCartAddShare: share(asinCartAdds, totalCartAdds),
      asinPurchaseShare: share(asinPurchases, totalPurchases),
    });
  }
  return out;
}

export function buildInsights(rows: SearchQueryMetrics[], ads: Map<string, AdsTermStats>): FunnelInsight[] {
  return aggregateWeeks(rows).map((m) => {
    const status = classifyFunnel(m);
    const ratios = funnelRatios(m);
    return {
      asin: m.asin,
      term: m.queryText,
      weeks: m.weeks,
      status,
      volume: m.totalQueryVolume,
      impressionShare: m.asinImpressionShare,
      clickShare: m.asinClickShare,
      cartShare: m.asinCartAddShare,
      purchaseShare: m.asinPurchaseShare,
      purchases: m.asinPurchases,
      ctr: r4(ratios.ctr),
      cartRate: r4(ratios.cartRate),
      purchaseRate: r4(ratios.purchaseRate),
      impactScore: funnelLeak(m, status).impactScore,
      asinPrice: m.asinMedianPrice,
      marketPrice: m.medianPrice,
      ads: ads.get(m.queryText),
    };
  });
}

const LISTING_FIX: Partial<Record<FunnelStatus, string>> = {
  DROP_IMPRESSIONS_TO_CLICKS: "Te ven pero no te pinchan: imagen principal, título (meter la búsqueda al principio), precio y valoraciones frente a los primeros resultados",
  DROP_CLICKS_TO_CART: "Entran pero no añaden al carrito: fotos secundarias, bullets y A+ que respondan a la búsqueda, precio y plazo de entrega (FBA/Prime)",
  DROP_CART_TO_PURCHASE: "Añaden pero no compran: precio frente a la Buy Box, coste y plazo de envío, cupón",
};

export function recommend(insights: FunnelInsight[], rows: SearchQueryMetrics[] = []): Recommendation[] {
  const out: Recommendation[] = [...listingLeaks(rows)];
  for (const i of insights) {
    const exactMaterial = i.purchases >= SCALE_MIN_PURCHASES && i.purchaseShare >= i.clickShare;
    const phraseMaterial = i.purchases >= PHRASE_MIN_PURCHASES && i.purchaseShare >= i.clickShare && i.purchaseShare > 0;
    if ((i.status === "WINNER" || exactMaterial) && !i.ads?.exactLive) {
      out.push({ kind: "scale", to: "exact", asin: i.asin, term: i.term, action: "Subir a EXACTA y negativizar en Auto/Frase", why: `${i.purchases} compras en ${i.weeks} semana(s); cuota de compras ${pct(i.purchaseShare)} ≥ cuota de clics ${pct(i.clickShare)}`, impact: i.volume });
    } else if (phraseMaterial && !i.ads?.exactLive) {
      out.push({ kind: "scale", to: "phrase", asin: i.asin, term: i.term, action: "Probar en FRASE", why: `${i.purchases} compra(s) (incluye orgánico); cuota de compras ${pct(i.purchaseShare)} ≥ cuota de clics ${pct(i.clickShare)}`, impact: i.volume });
    }
    // Click leak on one big search: the result is seen but loses the click for that query.
    if (i.impressionShare > 0 && i.volume > 0 && i.clickShare < i.impressionShare * LEAK_FACTOR && i.status !== "LOW_VOLUME") {
      out.push({ kind: "listing", asin: i.asin, term: i.term, action: `Para «${i.term}»: ${LISTING_FIX.DROP_IMPRESSIONS_TO_CLICKS}`, why: `impresiones ${pct(i.impressionShare)} → clics ${pct(i.clickShare)}`, impact: i.impactScore });
    }
    if (i.purchases > 0 && i.impressionShare < OPPORTUNITY_MAX_IMPRESSION_SHARE && i.volume >= OPPORTUNITY_MIN_VOLUME) {
      out.push({ kind: "opportunity", asin: i.asin, term: i.term, action: i.ads?.exactLive ? "Subir puja de la exacta / reforzar parte superior de búsqueda" : "Añadir en FRASE y meter la búsqueda en título o backend", why: `vende (${i.purchases} compras) pero solo sale en el ${pct(i.impressionShare)} de ${i.volume} búsquedas`, impact: i.volume });
    }
  }
  return out.sort((a, b) => b.impact - a.impact);
}

/**
 * Listing leaks per ASIN, adding all its search terms up and comparing each stage with the market
 * on the same searches: CTR, add-to-cart rate and purchase rate below LEAK_FACTOR × the market's.
 * The earliest failing stage is reported (fixing the click comes before fixing the cart).
 */
export function listingLeaks(rows: SearchQueryMetrics[]): Recommendation[] {
  const per = new Map<string, { imp: number; clk: number; cart: number; buy: number; tImp: number; tClk: number; tCart: number; tBuy: number; price: number | null; market: number | null; terms: number }>();
  for (const m of aggregateWeeks(rows)) {
    const a = per.get(m.asin) ?? { imp: 0, clk: 0, cart: 0, buy: 0, tImp: 0, tClk: 0, tCart: 0, tBuy: 0, price: m.asinMedianPrice, market: m.medianPrice, terms: 0 };
    a.imp += m.asinImpressions;
    a.clk += m.asinClicks;
    a.cart += m.asinCartAdds;
    a.buy += m.asinPurchases;
    a.tImp += m.totalImpressions;
    a.tClk += m.totalClicks;
    a.tCart += m.totalCartAdds;
    a.tBuy += m.totalPurchases;
    a.terms += 1;
    per.set(m.asin, a);
  }
  const out: Recommendation[] = [];
  const rate = (x: number, y: number) => (y > 0 ? x / y : 0);
  for (const [asin, a] of per) {
    const price = a.price !== null && a.market !== null ? ` · tu precio ${a.price} vs mediana del mercado ${a.market}` : "";
    const stages: Array<[boolean, string, string, number]> = [
      [a.imp >= ASIN_MIN_IMPRESSIONS, "DROP_IMPRESSIONS_TO_CLICKS", `CTR ${pct(rate(a.clk, a.imp))} vs mercado ${pct(rate(a.tClk, a.tImp))}`, rate(a.tClk, a.tImp) > 0 ? rate(a.clk, a.imp) / rate(a.tClk, a.tImp) : 1],
      [a.clk >= ASIN_MIN_CLICKS, "DROP_CLICKS_TO_CART", `carrito/clic ${pct(rate(a.cart, a.clk))} vs mercado ${pct(rate(a.tCart, a.tClk))}`, rate(a.tCart, a.tClk) > 0 ? rate(a.cart, a.clk) / rate(a.tCart, a.tClk) : 1],
      [a.cart >= ASIN_MIN_CARTS, "DROP_CART_TO_PURCHASE", `compra/carrito ${pct(rate(a.buy, a.cart))} vs mercado ${pct(rate(a.tBuy, a.tCart))}`, rate(a.tBuy, a.tCart) > 0 ? rate(a.buy, a.cart) / rate(a.tBuy, a.tCart) : 1],
    ];
    const leak = stages.find(([enough, , , ratio]) => enough && ratio < LEAK_FACTOR);
    if (!leak) continue;
    out.push({ kind: "listing", asin, term: `(${a.terms} búsquedas)`, action: LISTING_FIX[leak[1] as FunnelStatus] ?? "", why: `${leak[2]}${price}`, impact: a.imp });
  }
  return out;
}

/**
 * Terms to negate with the confirmation of both sources: Ads paid ≥ 2 € without sales and SQP shows
 * the ASIN got ≥ 10 clicks on that search in the period without a single purchase.
 */
export function confirmedCuts(rows: SearchQueryMetrics[], ads: Map<string, AdsTermStats>): Recommendation[] {
  const out: Recommendation[] = [];
  const byTerm = new Map<string, { clicks: number; purchases: number; asins: Set<string> }>();
  for (const m of aggregateWeeks(rows)) {
    const t = byTerm.get(m.queryText) ?? { clicks: 0, purchases: 0, asins: new Set<string>() };
    t.clicks += m.asinClicks;
    t.purchases += m.asinPurchases;
    t.asins.add(m.asin);
    byTerm.set(m.queryText, t);
  }
  for (const [term, t] of byTerm) {
    const a = ads.get(term);
    if (!a || a.spend < CUT_MIN_ADS_SPEND || a.sales > 0 || t.purchases > 0 || t.clicks < CUT_MIN_ASIN_CLICKS) continue;
    out.push({
      kind: "cut",
      asin: [...t.asins].join(", "),
      term,
      action: "Negativa exacta en las campañas que la pagan",
      why: `Ads: ${a.spend.toFixed(2)} € y ${a.clicks} clics sin ventas; SQP: ${t.clicks} clics del ASIN y 0 compras`,
      impact: Math.round(a.spend * 100) / 100,
    });
  }
  return out.sort((a, b) => b.impact - a.impact);
}

/** Purchase share of the last week vs the average of the previous ones, for terms with purchases. */
export function trends(rows: SearchQueryMetrics[], top = 15): TrendPoint[] {
  const weeks = [...new Set(rows.map((r) => r.periodStart))].sort();
  if (weeks.length < 2) return [];
  const last = weeks[weeks.length - 1];
  const prev = aggregateWeeks(rows.filter((r) => r.periodStart !== last));
  const now = new Map(aggregateWeeks(rows.filter((r) => r.periodStart === last)).map((m) => [`${m.asin}|${m.queryText}`, m]));
  return prev
    .filter((m) => m.asinPurchases > 0 || (now.get(`${m.asin}|${m.queryText}`)?.asinPurchases ?? 0) > 0)
    .map((m) => ({ asin: m.asin, term: m.queryText, previousShare: m.asinPurchaseShare, lastShare: now.get(`${m.asin}|${m.queryText}`)?.asinPurchaseShare ?? 0 }))
    .sort((a, b) => b.previousShare + b.lastShare - (a.previousShare + a.lastShare))
    .slice(0, top);
}
