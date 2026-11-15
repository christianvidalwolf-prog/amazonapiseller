import type { SearchTermReportRow } from "../../ads/reportTypes";

/**
 * Embudo de cosecha Auto → Frase → Exacta (spec advertising §15, Fase B).
 *
 * From the 30-day search-term report of the profit-first campaigns:
 *  - → EXACTA: ≥ 2 orders, ACoS < 25 % and ≥ 8 clicks in the discovery levels (auto + phrase),
 *    or straight from auto with ≥ 3 orders and ACoS < 15 %. Starting bid = its CPC + 10 % (cap 1,50 €).
 *  - → FRASE: from auto, ≥ 1 order and ACoS < 35 % (not yet exact material). Starting bid = its CPC.
 *  - ASIN searches that meet the exact rule → product target in the ASIN campaign.
 * Every promotion negates the term (negative exact / negative product target) in the campaigns it
 * came from, the same day, so the levels never compete. A term already live at the destination is
 * skipped. At most MAX_PER_DAY promotions per country, best sales first.
 */

export const EXACT_MIN_ORDERS = 2;
export const EXACT_MAX_ACOS = 25;
export const EXACT_MIN_CLICKS = 8;
export const JUMP_MIN_ORDERS = 3;
export const JUMP_MAX_ACOS = 15;
export const PHRASE_MIN_ORDERS = 1;
export const PHRASE_MAX_ACOS = 35;
export const MAX_PER_DAY = 10;
const MAX_BID = 1.5;
const MIN_BID = 0.15;
const ASIN_TERM = /^b0[a-z0-9]{8}$/i;

export type Level = "auto" | "phrase" | "exact" | "asin" | "other";
export type Destination = "phrase" | "exact" | "asin";

export interface Origin {
  campaignId: string;
  campaignName: string;
  adGroupId: string;
  level: Level;
}

export interface Promotion {
  term: string;
  to: Destination;
  bid: number;
  clicks: number;
  orders: number;
  spend: number;
  sales: number;
  acos: number;
  cpc: number;
  /** Where the term was found; each gets a negative of the term. */
  origins: Origin[];
  rule: string;
}

export function levelOf(campaignName: string): Level {
  const n = campaignName.toUpperCase();
  if (/\bAUTO\b/.test(n) || n.includes("FBA SELLERS")) return "auto";
  if (n.includes("FRASE") || n.includes("PHRASE")) return "phrase";
  if (n.includes("EXACTA") || n.includes("EXACT") || n.includes("MARCA")) return "exact";
  if (n.includes("ASIN")) return "asin";
  return "other";
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (n: number) => Math.round(n * 100) / 100;
export const normalize = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * @param rows search-term rows of the PF campaigns
 * @param campaignNames campaignId → name
 * @param live terms already targeted per destination (normalized keyword texts / ASINs)
 * @param blocked terms not to propose (failed promotions, user rejections)
 */
export function planFunnel(
  rows: SearchTermReportRow[],
  campaignNames: Map<string, string>,
  live: Record<Destination, Set<string>>,
  blocked: Set<string> = new Set()
): Promotion[] {
  const byTerm = new Map<string, { clicks: number; orders: number; spend: number; sales: number; autoOrders: number; autoSpend: number; autoSales: number; origins: Map<string, Origin> }>();
  for (const r of rows) {
    const term = normalize(String(r.searchTerm ?? ""));
    const campaignId = String(r.campaignId ?? "");
    const name = campaignNames.get(campaignId);
    if (!term || !name) continue;
    const level = levelOf(name);
    if (level !== "auto" && level !== "phrase") continue; // only discovery levels feed the funnel
    const t = byTerm.get(term) ?? { clicks: 0, orders: 0, spend: 0, sales: 0, autoOrders: 0, autoSpend: 0, autoSales: 0, origins: new Map() };
    t.clicks += num(r.clicks);
    t.orders += num(r.purchases7d);
    t.spend += num(r.cost);
    t.sales += num(r.sales7d);
    if (level === "auto") {
      t.autoOrders += num(r.purchases7d);
      t.autoSpend += num(r.cost);
      t.autoSales += num(r.sales7d);
    }
    const adGroupId = String(r.adGroupId ?? "");
    t.origins.set(`${campaignId}|${adGroupId}`, { campaignId, campaignName: name, adGroupId, level });
    byTerm.set(term, t);
  }

  const out: Promotion[] = [];
  for (const [term, t] of byTerm) {
    if (blocked.has(term) || t.sales <= 0) continue;
    const acos = (t.spend / t.sales) * 100;
    const autoAcos = t.autoSales > 0 ? (t.autoSpend / t.autoSales) * 100 : Infinity;
    const cpc = t.clicks > 0 ? t.spend / t.clicks : 0;
    const origins = [...t.origins.values()];
    const isAsin = ASIN_TERM.test(term);
    const exact = t.orders >= EXACT_MIN_ORDERS && acos < EXACT_MAX_ACOS && t.clicks >= EXACT_MIN_CLICKS;
    const jump = t.autoOrders >= JUMP_MIN_ORDERS && autoAcos < JUMP_MAX_ACOS;
    const base = { term, clicks: t.clicks, orders: t.orders, spend: round2(t.spend), sales: round2(t.sales), acos: round2(acos), cpc: round2(cpc) };
    if (exact || jump) {
      const to: Destination = isAsin ? "asin" : "exact";
      if (live[to].has(term)) continue;
      const rule = exact ? `${t.orders} pedidos, ACoS ${round2(acos)} %, ${t.clicks} clics` : `salto desde Auto: ${t.autoOrders} pedidos, ACoS ${round2(autoAcos)} %`;
      out.push({ ...base, to, bid: round2(Math.min(MAX_BID, Math.max(MIN_BID, cpc * 1.1))), origins, rule });
      continue;
    }
    if (isAsin) continue; // ASINs go straight to the ASIN campaign or nowhere
    const fromAuto = origins.filter((o) => o.level === "auto");
    if (fromAuto.length && t.autoOrders >= PHRASE_MIN_ORDERS && autoAcos < PHRASE_MAX_ACOS && !live.phrase.has(term) && !live.exact.has(term)) {
      out.push({ ...base, to: "phrase", bid: round2(Math.min(MAX_BID, Math.max(MIN_BID, cpc))), origins: fromAuto, rule: `señal en Auto: ${t.autoOrders} pedido(s), ACoS ${round2(autoAcos)} %` });
    }
  }
  const rank = { exact: 0, asin: 1, phrase: 2 } as const;
  return out.sort((a, b) => rank[a.to] - rank[b.to] || b.sales - a.sales).slice(0, MAX_PER_DAY);
}
