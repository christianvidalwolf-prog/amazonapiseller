/**
 * Country ACoS regulator (spec advertising §11). Goal set by the user: a country's 30-day ACoS
 * must not exceed 25 %; the regulator aims at 22 % to keep a margin for noise.
 *
 * It works on bid entities (keywords, manual targets and auto targeting clauses) with their own
 * spend/sales from the search-term report, only in the profit-first campaigns:
 *  - country ACoS above the target → every entity above the target (or spending ≥ 1 € without sales)
 *    gets bid × max(0.85, target / country ACoS): at most −15 % per run;
 *  - country ACoS below the low band → entities with ≥ 2 orders and ACoS < 15 % get +20 % (cap 1,50 €);
 *  - in between, nothing. Entities changed less than 14 days ago are left to mature.
 */

export const TARGET_ACOS = 22;
export const LIMIT_ACOS = 25;
export const LOW_BAND_ACOS = 18;
const MAX_STEP_DOWN = 0.15;
const STEP_UP = 0.2;
const MAX_BID = 1.5;
const MIN_BID = 0.02;
const WINNER_ACOS = 15;
const WINNER_ORDERS = 2;
const DEAD_SPEND = 1;

export interface BidEntity {
  id: string;
  kind: "keyword" | "target";
  label: string;
  bid: number;
  spend: number;
  sales: number;
  orders: number;
  clicks: number;
}

export interface BidChange {
  id: string;
  kind: BidEntity["kind"];
  label: string;
  oldBid: number;
  newBid: number;
  reason: string;
}

export interface RegulatorResult {
  countryAcos: number | null;
  mode: "down" | "up" | "hold" | "no_data";
  changes: BidChange[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function regulate(entities: BidEntity[], maturing: Set<string> = new Set()): RegulatorResult {
  const spend = entities.reduce((a, e) => a + e.spend, 0);
  const sales = entities.reduce((a, e) => a + e.sales, 0);
  if (sales <= 0) return { countryAcos: null, mode: "no_data", changes: [] };
  const countryAcos = round2((spend / sales) * 100);
  const live = entities.filter((e) => !maturing.has(e.id) && e.bid > 0);

  if (countryAcos > TARGET_ACOS) {
    const factor = Math.max(1 - MAX_STEP_DOWN, TARGET_ACOS / countryAcos);
    const changes = live
      .filter((e) => (e.sales > 0 ? (e.spend / e.sales) * 100 > TARGET_ACOS : e.spend >= DEAD_SPEND))
      .map((e) => {
        const acos = e.sales > 0 ? `ACoS ${round2((e.spend / e.sales) * 100)} %` : `${e.spend.toFixed(2)} € sin ventas`;
        return { id: e.id, kind: e.kind, label: e.label, oldBid: e.bid, newBid: Math.max(MIN_BID, round2(e.bid * factor)), reason: `País ${countryAcos} % > ${TARGET_ACOS} %; ${acos}` };
      })
      .filter((c) => c.newBid < c.oldBid);
    return { countryAcos, mode: "down", changes };
  }
  if (countryAcos < LOW_BAND_ACOS) {
    const changes = live
      .filter((e) => e.orders >= WINNER_ORDERS && e.sales > 0 && (e.spend / e.sales) * 100 < WINNER_ACOS)
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        label: e.label,
        oldBid: e.bid,
        newBid: round2(Math.min(MAX_BID, e.bid * (1 + STEP_UP))),
        reason: `País ${countryAcos} % < ${LOW_BAND_ACOS} %; ganador con ${e.orders} pedidos y ACoS ${round2((e.spend / e.sales) * 100)} %`,
      }))
      .filter((c) => c.newBid > c.oldBid);
    return { countryAcos, mode: "up", changes };
  }
  return { countryAcos, mode: "hold", changes: [] };
}
