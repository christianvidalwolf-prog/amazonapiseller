/** Consultas en vivo compartidas por los scripts de limpieza de listings. */
import type { SpApiClient } from "../../src/spapi/client";
import { getInventorySummaries } from "../../src/spapi/endpoints/fbaInventory";
import { getListingsItem } from "../../src/spapi/endpoints/listingsItems";
import { CLEANUP_MARKETPLACES } from "./listing-cleanup";

const ALL_IDS = Object.values(CLEANUP_MARKETPLACES);
/** Marketplaces con almacenes FBA (Pan-EU y UK) donde puede quedar inventario del SKU. */
const FBA_IDS = (["ES", "DE", "FR", "IT", "NL", "PL", "SE", "BE", "UK"] as const).map((c) => CLEANUP_MARKETPLACES[c]);
const isNotFound = (e: unknown) => /NOT_FOUND|not found|404/i.test(String(e));

export function cleanupApi(client: SpApiClient, sellerId: string) {
  /** El listing en todos los marketplaces EU a la vez, o null si el SKU no existe. */
  async function fetchListing(sku: string): Promise<any | null> {
    try {
      return await getListingsItem(client, { sellerId, sku, marketplaceIds: ALL_IDS, includedData: ["summaries", "attributes", "fulfillmentAvailability", "relationships"] });
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  /** Unidades FBA de cualquier tipo (vendibles, reservadas, en camino, no vendibles) por SKU. */
  async function fbaUnits(skus: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const skipped = new Set<string>();
    for (const mid of FBA_IDS) {
      for (let i = 0; i < skus.length; i += 50) {
        try {
          const res = await getInventorySummaries(client, { marketplaceIds: [mid], sellerSkus: skus.slice(i, i + 50) });
          for (const s of res.payload.inventorySummaries as any[]) {
            const d = s.inventoryDetails ?? {};
            const total = Number(s.totalQuantity ?? 0) + Number(d.inboundWorkingQuantity ?? 0) + Number(d.inboundShippedQuantity ?? 0) + Number(d.inboundReceivingQuantity ?? 0);
            out.set(s.sellerSku, (out.get(s.sellerSku) ?? 0) + total);
          }
        } catch (e) {
          // Marketplace sin programa FBA o sin acceso para la cuenta: no aporta inventario.
          // En ES tiene que funcionar siempre; si falla ahí no se puede dar nada por vacío.
          const noAccess = /InvalidInput|Unauthorized|participat|registered|\b40[03]\b/i.test(String(e)) || [400, 403].includes((e as any)?.statusCode);
          if (mid === CLEANUP_MARKETPLACES.ES || !noAccess) throw e;
          if (!skipped.has(mid)) { skipped.add(mid); console.log(`  inventario FBA no disponible en ${mid} (${(e as any)?.statusCode ?? "?"}), se omite`); }
          break;
        }
      }
    }
    return out;
  }

  return { fetchListing, fbaUnits };
}

export async function pool<T>(items: T[], size: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }));
}
