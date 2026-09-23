import fs from "node:fs";
import path from "node:path";
import type { SpApiClient } from "../../spapi/client";
import { getInventorySummaries, type InventorySummary } from "../../spapi/endpoints/fbaInventory";

export interface InventoryRow {
  sku: string;
  asin: string;
  name?: string;
  total?: number;
  fulfillable: number;
  reserved: number;
  inbound: number;
  price?: number;
  fulfillmentChannel?: "FBA" | "FBM";
  status?: string;
}

export class InventoryService {
  constructor(private readonly client: SpApiClient, private readonly marketplaceIds: string[]) {}

  /** Live pull from FBA Inventory API or fast read from local CSV cache if present. */
  async getInventorySnapshot(): Promise<InventoryRow[]> {
    const fs = await import("node:fs");
    const path = await import("node:path");

    // 1. Cargar detalles FBA primero en un mapa si existe inventario_fba.csv
    const fbaMap = new Map<string, { fulfillable: number; reserved: number; inbound: number; total: number }>();
    const fbaCsvPath = path.resolve(process.cwd(), "..", "inventario_fba.csv");
    const altFbaCsvPath = path.resolve(process.cwd(), "inventario_fba.csv");
    const targetFbaPath = fs.existsSync(fbaCsvPath) ? fbaCsvPath : fs.existsSync(altFbaCsvPath) ? altFbaCsvPath : null;

    if (targetFbaPath) {
      try {
        const text = fs.readFileSync(targetFbaPath, "utf-8");
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length > 1) {
          const headers = lines[0].replace(/^\uFEFF/, "").split(";");
          const skuIdx = headers.indexOf("SKU");
          const totalIdx = headers.indexOf("Total");
          const dispIdx = headers.indexOf("Disponible");
          const resIdx = headers.indexOf("Reservado");
          const inbIdx = headers.indexOf("En camino (Inbound)");

          for (const line of lines.slice(1)) {
            const parts = line.split(";");
            if (parts.length < headers.length) continue;
            const sku = parts[skuIdx];
            if (!sku) continue;
            fbaMap.set(sku, {
              total: totalIdx !== -1 ? Number.parseInt(parts[totalIdx], 10) || 0 : 0,
              fulfillable: dispIdx !== -1 ? Number.parseInt(parts[dispIdx], 10) || 0 : 0,
              reserved: resIdx !== -1 ? Number.parseInt(parts[resIdx], 10) || 0 : 0,
              inbound: inbIdx !== -1 ? Number.parseInt(parts[inbIdx], 10) || 0 : 0,
            });
          }
        }
      } catch (err) {
        console.warn("Error leyendo inventario_fba.csv:", err);
      }
    }

    // 2. Cargar el catálogo completo maestro (30,921 productos FBA + FBM)
    const catCsvPath = path.resolve(process.cwd(), "..", "catalogo_completo.csv");
    const altCatCsvPath = path.resolve(process.cwd(), "catalogo_completo.csv");
    const targetCatPath = fs.existsSync(catCsvPath) ? catCsvPath : fs.existsSync(altCatCsvPath) ? altCatCsvPath : null;

    if (targetCatPath) {
      try {
        const text = fs.readFileSync(targetCatPath, "utf-8");
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length > 1) {
          const headers = lines[0].replace(/^\uFEFF/, "").replace(/^[^\w]+/, "").split(";");
          const skuIdx = headers.indexOf("seller-sku");
          const asinIdx = headers.indexOf("asin1");
          const nameIdx = headers.indexOf("item-name");
          const priceIdx = headers.indexOf("price");
          const qtyIdx = headers.indexOf("quantity");
          const statusIdx = headers.indexOf("status");
          const channelIdx = headers.indexOf("fulfillment-channel");

          const rows: InventoryRow[] = [];
          for (const line of lines.slice(1)) {
            const parts = line.split(";");
            if (parts.length < headers.length) continue;
            const sku = parts[skuIdx];
            if (!sku) continue;

            const isFba = parts[channelIdx] === "AMAZON_EU";
            const price = Number.parseFloat((parts[priceIdx] || "0").replace(",", ".")) || 0;
            const catQty = Number.parseInt(parts[qtyIdx], 10) || 0;

            const fbaDetails = fbaMap.get(sku);

            rows.push({
              sku,
              asin: parts[asinIdx] || "",
              name: parts[nameIdx] || "",
              total: fbaDetails ? fbaDetails.total : catQty,
              fulfillable: fbaDetails ? fbaDetails.fulfillable : catQty,
              reserved: fbaDetails ? fbaDetails.reserved : 0,
              inbound: fbaDetails ? fbaDetails.inbound : 0,
              price,
              fulfillmentChannel: isFba ? "FBA" : "FBM",
              status: parts[statusIdx] || "Active",
            });
          }

          return rows;
        }
      } catch (err) {
        console.warn("Error leyendo catalogo_completo.csv en inventory:", err);
      }
    }

    const rows: InventoryRow[] = [];
    let nextToken: string | undefined;

    do {
      const response = await getInventorySummaries(this.client, {
        marketplaceIds: this.marketplaceIds,
        nextToken,
      });
      rows.push(...response.payload.inventorySummaries.map(toRow));
      nextToken = response.pagination?.nextToken;
    } while (nextToken);

    return rows;
  }
}

function toRow(summary: InventorySummary): InventoryRow {
  const details = summary.inventoryDetails;
  return {
    sku: summary.sellerSku,
    asin: summary.asin,
    fulfillable: details?.fulfillableQuantity ?? 0,
    reserved: details?.reservedQuantity.totalReservedQuantity ?? 0,
    inbound:
      (details?.inboundWorkingQuantity ?? 0) +
      (details?.inboundShippedQuantity ?? 0) +
      (details?.inboundReceivingQuantity ?? 0),
  };
}
