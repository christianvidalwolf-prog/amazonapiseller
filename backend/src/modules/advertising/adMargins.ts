import type { AdvertisedProductReportRow } from "../../ads/reportTypes";
import { type AdsReportStore, adsMarginsKey } from "./adsReports.store";
import { type MarginInput, unitProfitBeforeAds } from "./profitability";

const MARGINS_SNAPSHOT_KEY = "margins:products";

/** The part of PricingService.getUnitMargin the bridge needs. */
export interface UnitMarginLike {
  price: number;
  fees: { total: number | null };
  landedCost: number | null;
  cost: { vatRate: number | null } | null;
}

export interface AdMarginsSnapshot {
  generatedAt: string;
  items: Array<MarginInput & { error?: string }>;
}

/**
 * Unit margins for every SKU in the advertised-products report — FBM and
 * out-of-stock FBA included, which margins:products (active FBA inventory only)
 * leaves out. A SKU whose margin cannot be built keeps nulls and its error, so
 * the bridge classifies it as "no_cost" instead of guessing.
 */
export async function buildAdMargins(
  rows: AdvertisedProductReportRow[],
  unitMargin: (sku: string) => Promise<UnitMarginLike>,
  now = new Date()
): Promise<AdMarginsSnapshot> {
  const skus = [...new Set(rows.map((r) => String(r.advertisedSku ?? "").trim()).filter(Boolean))];
  const items: AdMarginsSnapshot["items"] = [];
  for (const sku of skus) {
    try {
      const m = await unitMargin(sku);
      items.push({ sku, price: m.price, feesTotal: m.fees.total, landedCost: m.landedCost, vatRate: m.cost?.vatRate ?? null });
    } catch (err) {
      items.push({ sku, price: null, feesTotal: null, landedCost: null, vatRate: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { generatedAt: now.toISOString(), items };
}

/** Margins built for the advertised SKUs (ads:margins) win over the active-FBA margins:products snapshot. */
export async function loadMarginInputs(store: AdsReportStore, profileId: string): Promise<MarginInput[]> {
  type Item = { sku: string; price: number | null; fees?: { total: number | null }; landedCost: number | null; cost?: { vatRate: number | null } };
  const [adMargins, products] = await Promise.all([
    store.readSnapshot<AdMarginsSnapshot>(adsMarginsKey(profileId)),
    store.readSnapshot<{ items?: Item[] }>(MARGINS_SNAPSHOT_KEY),
  ]);
  const bySku = new Map<string, MarginInput>(
    (products?.items ?? []).map((i) => [
      i.sku.toUpperCase(),
      { sku: i.sku, price: i.price, feesTotal: i.fees?.total ?? null, landedCost: i.landedCost, vatRate: i.cost?.vatRate ?? null },
    ])
  );
  for (const m of adMargins?.items ?? []) {
    if (unitProfitBeforeAds(m) !== null || !bySku.has(m.sku.toUpperCase())) bySku.set(m.sku.toUpperCase(), m);
  }
  return [...bySku.values()];
}

