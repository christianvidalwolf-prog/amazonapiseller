import type { AdvertisedProductReportRow } from "../../ads/reportTypes";
import { type AdsReportStore, adsMarginsKey } from "./adsReports.store";
import { type MarginInput, unitProfitBeforeAds } from "./profitability";

const MARGINS_SNAPSHOT_KEY = "margins:products";

/** Standard VAT of each marketplace country: the price customers pay there includes it. */
export const VAT_BY_COUNTRY: Record<string, number> = { ES: 21, DE: 19, FR: 20, IT: 22, NL: 21, BE: 21, UK: 20, PL: 23, SE: 25 };

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
  now = new Date(),
  /** Country VAT (%); wins over Sellerboard's per-SKU rate, which is the Spanish one. */
  vatRate?: number
): Promise<AdMarginsSnapshot> {
  const skus = [...new Set(rows.map((r) => String(r.advertisedSku ?? "").trim()).filter(Boolean))];
  const items: AdMarginsSnapshot["items"] = [];
  for (const sku of skus) {
    try {
      const m = await unitMargin(sku);
      items.push({ sku, price: m.price, feesTotal: m.fees.total, landedCost: m.landedCost, vatRate: vatRate ?? m.cost?.vatRate ?? null });
    } catch (err) {
      items.push({ sku, price: null, feesTotal: null, landedCost: null, vatRate: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { generatedAt: now.toISOString(), items };
}

/**
 * Margins built for the advertised SKUs (ads:margins) win over the active-FBA margins:products
 * snapshot, which holds Spanish prices and is only used for the ES profile (or when no country is given).
 */
export async function loadMarginInputs(store: AdsReportStore, profileId: string, country?: string): Promise<MarginInput[]> {
  type Item = { sku: string; price: number | null; fees?: { total: number | null }; landedCost: number | null; cost?: { vatRate: number | null } };
  const [adMargins, products] = await Promise.all([
    store.readSnapshot<AdMarginsSnapshot>(adsMarginsKey(profileId)),
    !country || country === "ES" ? store.readSnapshot<{ items?: Item[] }>(MARGINS_SNAPSHOT_KEY) : Promise.resolve(null),
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

