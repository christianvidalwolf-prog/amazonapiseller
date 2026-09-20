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
}

export class InventoryService {
  constructor(private readonly client: SpApiClient, private readonly marketplaceIds: string[]) {}

  /** Live pull from FBA Inventory API or fast read from local CSV cache if present. */
  async getInventorySnapshot(): Promise<InventoryRow[]> {
    // 1. Intentar cargar desde inventario_fba.csv para respuesta ultra rápida
    const csvPath = path.resolve(process.cwd(), "..", "inventario_fba.csv");
    const altCsvPath = path.resolve(process.cwd(), "inventario_fba.csv");
    const targetPath = fs.existsSync(csvPath) ? csvPath : fs.existsSync(altCsvPath) ? altCsvPath : null;

    if (targetPath) {
      try {
        const text = fs.readFileSync(targetPath, "utf-8");
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length > 1) {
          const headers = lines[0].replace(/^\uFEFF/, "").split(";");
          const skuIdx = headers.indexOf("SKU");
          const asinIdx = headers.indexOf("ASIN");
          const nameIdx = headers.indexOf("Nombre");
          const totalIdx = headers.indexOf("Total");
          const dispIdx = headers.indexOf("Disponible");
          const resIdx = headers.indexOf("Reservado");
          const inbIdx = headers.indexOf("En camino (Inbound)");

          const rows: InventoryRow[] = [];
          for (const line of lines.slice(1)) {
            const parts = line.split(";");
            if (parts.length < headers.length) continue;
            rows.push({
              sku: parts[skuIdx] || "",
              asin: parts[asinIdx] || "",
              name: nameIdx !== -1 ? parts[nameIdx] : "",
              total: totalIdx !== -1 ? Number.parseInt(parts[totalIdx], 10) || 0 : 0,
              fulfillable: dispIdx !== -1 ? Number.parseInt(parts[dispIdx], 10) || 0 : 0,
              reserved: resIdx !== -1 ? Number.parseInt(parts[resIdx], 10) || 0 : 0,
              inbound: inbIdx !== -1 ? Number.parseInt(parts[inbIdx], 10) || 0 : 0,
            });
          }
          return rows;
        }
      } catch (err) {
        console.warn("No se pudo leer inventario_fba.csv local, usando llamada SP-API:", err);
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
