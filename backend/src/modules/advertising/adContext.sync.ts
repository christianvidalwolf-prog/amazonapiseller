import type { AdvertisedProductReportRow } from "../../ads/reportTypes";
import type { SpApiClient } from "../../spapi/client";
import { getInventorySummaries } from "../../spapi/endpoints/fbaInventory";
import { getItemOffers } from "../../spapi/endpoints/productPricing";
import { type AdContextSnapshot, buildSkuContext, ownBuyBox } from "./adContext";

type UnitsBySku = Record<string, { units: number; returnedUnits: number }>;

/** Project convention (pricing, replication): FBA SKUs end in "FBA"; the rest ship from our warehouse (FBM). */
export const isFbaSku = (sku: string) => sku.toUpperCase().endsWith("FBA");

export interface AdContextSources {
  /** FBA sellable units per SKU in the marketplace (SKUs without FBA record are absent). */
  fulfillable: (skus: string[]) => Promise<Map<string, number>>;
  /** Whether our own offer holds the Buy Box for the ASIN; null if unknown. */
  buyBox: (asin: string) => Promise<boolean | null>;
  units30: UnitsBySku;
  units90: UnitsBySku;
}

/**
 * Circuit-breaker context of every SKU in the advertised-products report. Buy Box is only
 * checked for SKUs that spent in the window (getItemOffers allows 0.5 requests/s).
 */
export async function collectAdContext(
  rows: AdvertisedProductReportRow[],
  sources: AdContextSources,
  now = new Date()
): Promise<{ snapshot: AdContextSnapshot; buyBoxErrors: number }> {
  const bySku = new Map<string, { asin: string | null; spend: number }>();
  for (const r of rows) {
    const sku = String(r.advertisedSku ?? "").trim();
    if (!sku) continue;
    const prev = bySku.get(sku);
    bySku.set(sku, { asin: prev?.asin ?? r.advertisedAsin ?? null, spend: (prev?.spend ?? 0) + Number(r.cost ?? 0) });
  }
  // FBA Inventory also returns empty records for FBM SKUs: their stock is ours, not Amazon's.
  const fulfillable = await sources.fulfillable([...bySku.keys()].filter(isFbaSku));

  const buyBoxByAsin = new Map<string, boolean | null>();
  let buyBoxErrors = 0;
  for (const { asin, spend } of bySku.values()) {
    if (!asin || spend <= 0 || buyBoxByAsin.has(asin)) continue;
    try {
      buyBoxByAsin.set(asin, await sources.buyBox(asin));
    } catch {
      buyBoxErrors += 1;
      buyBoxByAsin.set(asin, null);
    }
  }

  const items = [...bySku].map(([sku, { asin }]) =>
    buildSkuContext({
      sku,
      asin,
      fulfillable: isFbaSku(sku) && fulfillable.has(sku) ? (fulfillable.get(sku) as number) : null,
      units30: sources.units30[sku]?.units ?? 0,
      units90: sources.units90[sku]?.units ?? 0,
      returned90: sources.units90[sku]?.returnedUnits ?? 0,
      buyBox: asin ? (buyBoxByAsin.get(asin) ?? null) : null,
    })
  );
  return { snapshot: { generatedAt: now.toISOString(), items }, buyBoxErrors };
}

/** SP-API implementations of the sources that call Amazon. */
export function spApiContextSources(client: SpApiClient, marketplaceId: string, sellerId: string) {
  return {
    async fulfillable(skus: string[]): Promise<Map<string, number>> {
      const out = new Map<string, number>();
      for (let i = 0; i < skus.length; i += 50) {
        let nextToken: string | undefined;
        do {
          const res = await getInventorySummaries(client, { marketplaceIds: [marketplaceId], sellerSkus: skus.slice(i, i + 50), nextToken });
          for (const s of res.payload?.inventorySummaries ?? []) {
            out.set(s.sellerSku, s.inventoryDetails?.fulfillableQuantity ?? 0);
          }
          nextToken = res.pagination?.nextToken;
        } while (nextToken);
      }
      return out;
    },
    async buyBox(asin: string): Promise<boolean | null> {
      const raw = await getItemOffers(client, { marketplaceId, asin });
      const offers = ((raw.payload as Record<string, unknown>)?.Offers ?? []) as Array<Record<string, unknown>>;
      return ownBuyBox(offers, sellerId);
    },
  };
}
