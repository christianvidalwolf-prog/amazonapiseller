/**
 * Circuit breakers of each advertised SKU (spec advertising §9): stock cover (WOC),
 * Buy Box and return rate. `alpha` multiplies the target ACoS / max bid:
 *   no Buy Box or no stock → 0 (pause), WOC < 2 → 0.1, 2-4 → 0.5, 4-6 → 0.8, ≥ 6 → 1.
 */

export type ContextFlag =
  | "SIN_BUY_BOX"
  | "SIN_STOCK"
  | "ROTURA_INMINENTE"
  | "RIESGO_ROTURA"
  | "STOCK_MEDIO"
  | "STOCK_NO_VERIFICADO";

export interface SkuContextInput {
  sku: string;
  asin: string | null;
  /** FBA sellable units in the marketplace; null when the SKU has no FBA inventory record (FBM). */
  fulfillable: number | null;
  /** Units sold in the channel over the last 30 days. */
  units30: number;
  /** Units sold / returned over the last 90 days (return rate). */
  units90: number;
  returned90: number;
  /** Own offer holds the Buy Box; null if unknown. */
  buyBox: boolean | null;
}

export interface SkuContext {
  sku: string;
  asin: string | null;
  fulfillable: number | null;
  unitsPerWeek: number;
  /** Weeks of cover; null without stock data or without sales velocity. */
  woc: number | null;
  buyBox: boolean | null;
  /** Returned / sold units over 90 days; null below MIN_UNITS_FOR_RETURN_RATE. */
  returnRate: number | null;
  alpha: number;
  flags: ContextFlag[];
}

export interface AdContextSnapshot {
  generatedAt: string;
  items: SkuContext[];
}

export const MIN_UNITS_FOR_RETURN_RATE = 10;

const round2 = (n: number) => Math.round(n * 100) / 100;

export function stockAlpha(fulfillable: number | null, unitsPerWeek: number): { alpha: number; woc: number | null; flag?: ContextFlag } {
  if (fulfillable === null) return { alpha: 1, woc: null, flag: "STOCK_NO_VERIFICADO" };
  if (fulfillable <= 0) return { alpha: 0, woc: 0, flag: "SIN_STOCK" };
  if (unitsPerWeek <= 0) return { alpha: 1, woc: null };
  const woc = fulfillable / unitsPerWeek;
  if (woc < 2) return { alpha: 0.1, woc, flag: "ROTURA_INMINENTE" };
  if (woc < 4) return { alpha: 0.5, woc, flag: "RIESGO_ROTURA" };
  if (woc < 6) return { alpha: 0.8, woc, flag: "STOCK_MEDIO" };
  return { alpha: 1, woc };
}

export function buildSkuContext(input: SkuContextInput): SkuContext {
  const unitsPerWeek = round2((input.units30 / 30) * 7);
  const stock = stockAlpha(input.fulfillable, unitsPerWeek);
  const flags: ContextFlag[] = [];
  if (input.buyBox === false) flags.push("SIN_BUY_BOX");
  if (stock.flag) flags.push(stock.flag);
  return {
    sku: input.sku,
    asin: input.asin,
    fulfillable: input.fulfillable,
    unitsPerWeek,
    woc: stock.woc === null ? null : round2(stock.woc),
    buyBox: input.buyBox,
    returnRate: input.units90 >= MIN_UNITS_FOR_RETURN_RATE ? Math.round((input.returned90 / input.units90) * 1000) / 1000 : null,
    alpha: input.buyBox === false ? 0 : stock.alpha,
    flags,
  };
}

/** From an item-offers payload: does our own offer hold the Buy Box? null when it cannot be told. */
export function ownBuyBox(offers: Array<Record<string, unknown>>, sellerId: string): boolean | null {
  const mine = offers.find((o) => o.MyOffer === true || o.SellerId === sellerId);
  if (mine) return mine.IsBuyBoxWinner === true;
  return offers.some((o) => o.IsBuyBoxWinner === true) ? false : null;
}
