/**
 * ACoS regulator (spec advertising §11). Goal set by the user: a country's 30-day ACoS must not
 * exceed 25 %; the regulator aims at 22 % to keep a margin for noise.
 *
 * Runs daily on bid entities (keywords, manual targets and auto targeting clauses) with their own
 * spend/sales from the search-term report, only in the profit-first campaigns. Each entity is
 * judged on its own numbers (not the country average) against its own target ACoS — since
 * 2026-11-25 min(22 %, 0.8 × break-even of the ad group's products) (`adGroupTargetAcos`); the
 * 22 % below is that cap:
 *  - with sales and ACoS above 22 % → bid × max(0.70, 22 / its ACoS);
 *  - without sales → −50 % at ≥ 15 clicks and ≥ 5 €, −30 % at ≥ 8 clicks or ≥ 2 €, −15 % at ≥ 1 €;
 *  - winners get a small daily raise (see raiseFor), cap 1,50 €.
 * Bids never go below 0,10 € by this rule. Entities changed less than BID_COOLDOWN_DAYS ago are
 * left alone so the cut shows in the data before the next one.
 *
 * Country brake (2026-11-25, ACoS ES 38 %, FR 52 %, DE 77 % after pacing kept raising bids):
 *  - country ACoS above the 25 % limit → no pacing raises at all (only proven winners, halved);
 *  - country ACoS above 35 % → no raises of any kind, and cuts get harsher: entities aim at 18 %,
 *    step down up to −40 %, and no-sale spend is cut −30 % from 1 €, −50 % from 2 € or 8 clicks.
 */

export const BID_COOLDOWN_DAYS = 4;
export const TARGET_ACOS = 22;
export const LIMIT_ACOS = 25;
export const LOW_BAND_ACOS = 18;
const MAX_STEP_DOWN = 0.3;
const STEP_UP_STRONG = 0.1;
const STEP_UP_GOOD = 0.05;
const GOOD_ACOS = 20;
const GOOD_ORDERS = 3;
/** Pacing (profit first): below this share of the country budget spent, push profitable traffic. */
export const PACING_UTILIZATION = 0.85;
/** Pacing opens up exploration only while the country ACoS is under this. */
const PACING_MAX_COUNTRY_ACOS = 30;
const PACING_STEP = 0.12;
const PACING_GOOD_ACOS = 25;
/** Bids under this do not win auctions; pacing lifts non-losers to it. */
const USEFUL_BID = 0.15;
/** Exploration (entities with no verdict yet) never goes above this. */
const EXPLORE_MAX_BID = 0.4;
const MAX_BID = 1.5;
const FLOOR_BID = 0.1;
const WINNER_ACOS = 15;
const WINNER_ORDERS = 2;
/** Country ACoS above this: brake — only cuts, harsher ones. */
export const BRAKE_ACOS = 35;
const BRAKE_TARGET_ACOS = 18;
const BRAKE_MAX_STEP_DOWN = 0.4;

export interface BidEntity {
  id: string;
  kind: "keyword" | "target";
  label: string;
  bid: number;
  spend: number;
  sales: number;
  orders: number;
  clicks: number;
  /** Own target ACoS (ad group: min(22 %, 0.8 × break-even), structure.ts); default TARGET_ACOS. */
  targetAcos?: number;
}

export interface BidChange {
  id: string;
  kind: BidEntity["kind"];
  label: string;
  oldBid: number;
  newBid: number;
  reason: string;
  /** Already at the bid floor and still losing: pause the keyword/target instead of cutting. */
  pause?: boolean;
}

export interface RegulatorResult {
  countryAcos: number | null;
  mode: "down" | "up" | "hold" | "no_data";
  changes: BidChange[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * At the bid floor a cut can do nothing more: pause when it is clearly losing — ≥ 2 € without sales,
 * or ACoS above twice the 25 % limit with ≥ 2 €.
 */
const PAUSE_MIN_SPEND = 2;
function pausable(e: BidEntity): boolean {
  if (e.bid > FLOOR_BID || e.spend < PAUSE_MIN_SPEND) return false;
  return e.sales <= 0 || (e.spend / e.sales) * 100 > Math.min(LIMIT_ACOS, targetOf(e)) * 2;
}

const targetOf = (e: BidEntity) => e.targetAcos ?? TARGET_ACOS;
/** Under the country brake the target is 18 %, or the entity's own target if lower. */
const brakeTargetOf = (e: BidEntity) => Math.min(BRAKE_TARGET_ACOS, targetOf(e));

/** Bid factor for one entity from its own numbers, or null when it is fine / too little data. */
function cutFor(e: BidEntity, brake: boolean): { factor: number; why: string } | null {
  if (e.sales > 0) {
    const acos = (e.spend / e.sales) * 100;
    const target = brake ? brakeTargetOf(e) : targetOf(e);
    if (acos <= target) return null;
    const maxStep = brake ? BRAKE_MAX_STEP_DOWN : MAX_STEP_DOWN;
    return { factor: Math.max(1 - maxStep, target / acos), why: `ACoS ${round2(acos)} %` };
  }
  const why = `${e.spend.toFixed(2)} € y ${e.clicks} clics sin ventas`;
  if (brake) {
    if (e.clicks >= 8 || e.spend >= 2) return { factor: 0.5, why };
    if (e.spend >= 1) return { factor: 0.7, why };
    return null;
  }
  if (e.clicks >= 15 && e.spend >= 5) return { factor: 0.5, why };
  if (e.clicks >= 8 || e.spend >= 2) return { factor: 0.7, why };
  if (e.spend >= 1) return { factor: 0.85, why };
  return null;
}

/**
 * Small daily raise for proven winners, to win more sales without hurting profit:
 *  - ACoS < 15 % and ≥ 2 orders → +10 %; ACoS 15–20 % and ≥ 3 orders → +5 %;
 *  - halved while the country is above the 25 % limit (winners pull the average down, but slowly).
 */
function raiseFor(e: BidEntity, countryAcos: number | null): { step: number; why: string } | null {
  if (e.sales <= 0) return null;
  const acos = (e.spend / e.sales) * 100;
  if (acos > targetOf(e)) return null;
  let step = 0;
  if (acos < WINNER_ACOS && e.orders >= WINNER_ORDERS) step = STEP_UP_STRONG;
  else if (acos < GOOD_ACOS && e.orders >= GOOD_ORDERS) step = STEP_UP_GOOD;
  if (!step) return null;
  if (countryAcos !== null && countryAcos > LIMIT_ACOS) step /= 2;
  return { step, why: `ganadora: ${e.orders} pedidos, ACoS ${round2(acos)} % → +${Math.round(step * 100)} %` };
}

/**
 * Pacing: when the country spends under 85 % of its budget, extra traffic is bought only where it
 * pays. Profitable entities (ACoS < 25 %) +12 %; while the country ACoS is under 30 %, entities with
 * no verdict yet (< 10 clicks, < 1 € without sales) also +12 % up to 0,40 €; non-losers bidding under
 * 0,15 € are lifted to 0,15 €. Above the 25 % country limit pacing does nothing.
 */
function paceFor(e: BidEntity, countryAcos: number | null, utilization: number | undefined): { bid: number; why: string } | null {
  if (utilization === undefined || utilization >= PACING_UTILIZATION) return null;
  if (countryAcos !== null && countryAcos > LIMIT_ACOS) return null;
  const open = countryAcos === null || countryAcos < PACING_MAX_COUNTRY_ACOS;
  const use = `uso presupuesto ${Math.round(utilization * 100)} %`;
  if (e.sales > 0 && (e.spend / e.sales) * 100 < Math.min(PACING_GOOD_ACOS, e.targetAcos ?? PACING_GOOD_ACOS)) {
    return { bid: Math.max(USEFUL_BID, e.bid * (1 + PACING_STEP)), why: `ritmo: ${use}, rentable (ACoS ${round2((e.spend / e.sales) * 100)} %) → +12 %` };
  }
  if (!open || e.sales > 0) return null;
  if (e.clicks < 10 && e.spend < 1) {
    return { bid: Math.min(EXPLORE_MAX_BID, Math.max(USEFUL_BID, e.bid * (1 + PACING_STEP))), why: `ritmo: ${use}, sin datos suficientes (${e.clicks} clics) → explorar` };
  }
  return null;
}

export function regulate(entities: BidEntity[], maturing: Set<string> = new Set(), utilization?: number): RegulatorResult {
  const spend = entities.reduce((a, e) => a + e.spend, 0);
  const sales = entities.reduce((a, e) => a + e.sales, 0);
  if (sales <= 0 && spend <= 0) return { countryAcos: null, mode: "no_data", changes: [] };
  const countryAcos = sales > 0 ? round2((spend / sales) * 100) : null;
  const live = entities.filter((e) => !maturing.has(e.id) && e.bid > 0);
  const brake = countryAcos === null ? spend > 0 : countryAcos > BRAKE_ACOS;
  const changes: BidChange[] = [];
  for (const e of live) {
    const cut = cutFor(e, brake);
    if (!cut) continue;
    const newBid = Math.max(FLOOR_BID, round2(e.bid * cut.factor));
    if (newBid >= e.bid && pausable(e)) {
      changes.push({ id: e.id, kind: e.kind, label: e.label, oldBid: e.bid, newBid: e.bid, pause: true, reason: `${cut.why} con la puja ya en el mínimo (${e.bid} €) → pausa` });
      continue;
    }
    const target = brake ? `${brakeTargetOf(e)} % (freno: país > ${BRAKE_ACOS} %)` : `${targetOf(e)} %${e.targetAcos !== undefined && e.targetAcos < TARGET_ACOS ? " (margen del producto)" : ""}`;
    if (newBid < e.bid) changes.push({ id: e.id, kind: e.kind, label: e.label, oldBid: e.bid, newBid, reason: `${cut.why} > objetivo ${target}${countryAcos !== null ? ` (país ${countryAcos} %)` : ""}` });
  }
  if (brake) return { countryAcos, mode: "down", changes };
  const cut = new Set(changes.map((c) => c.id));
  for (const e of live) {
    if (cut.has(e.id)) continue;
    const up = raiseFor(e, countryAcos);
    const pace = paceFor(e, countryAcos, utilization);
    const byRaise = up ? e.bid * (1 + up.step) : 0;
    const best = pace && pace.bid > byRaise ? { bid: pace.bid, why: pace.why } : up ? { bid: byRaise, why: up.why } : null;
    if (!best) continue;
    const newBid = round2(Math.min(MAX_BID, best.bid));
    if (newBid > e.bid) changes.push({ id: e.id, kind: e.kind, label: e.label, oldBid: e.bid, newBid, reason: best.why });
  }
  const mode = countryAcos === null || countryAcos > TARGET_ACOS ? "down" : countryAcos < LOW_BAND_ACOS ? "up" : "hold";
  return { countryAcos, mode, changes };
}
