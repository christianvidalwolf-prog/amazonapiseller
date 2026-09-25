import fs from "node:fs";
import path from "node:path";
import type { SpApiClient } from "../../spapi/client";
import { getInventorySummaries, type InventorySummary } from "../../spapi/endpoints/fbaInventory";
import { getPricing } from "../../spapi/endpoints/productPricing";

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
  constructor(private readonly client: SpApiClient, private readonly marketplaceIds: string[], private readonly sellerId: string) {}

  /** Live pull from FBA Inventory API or fast read from local CSV cache if present. */
  async getInventorySnapshot(marketplaceId = this.marketplaceIds[0], includePrices = true): Promise<InventoryRow[]> {
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

    // 2. Cargar precios del catálogo completo maestro si existe
    const catCsvPath = path.resolve(process.cwd(), "..", "catalogo_completo.csv");
    const altCatCsvPath = path.resolve(process.cwd(), "catalogo_completo.csv");
    const targetCatPath = fs.existsSync(catCsvPath) ? catCsvPath : fs.existsSync(altCatCsvPath) ? altCatCsvPath : null;

    const catalogPriceMap = new Map<string, { price: number; name?: string }>();
    // Listings merchant-fulfilled (fulfillment-channel=DEFAULT) no aparecen en
    // la FBA Inventory API ni en inventario_fba.csv: salen solo del catálogo.
    const fbmRows: InventoryRow[] = [];
    if (targetCatPath) {
      try {
        const text = fs.readFileSync(targetCatPath, "utf-8");
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length > 1) {
          const headers = lines[0].replace(/^\uFEFF/, "").replace(/^[^\w]+/, "").split(";");
          const skuIdx = headers.indexOf("seller-sku");
          const nameIdx = headers.indexOf("item-name");
          const priceIdx = headers.indexOf("price");
          const asinIdx = headers.indexOf("asin1");
          const qtyIdx = headers.indexOf("quantity");
          const channelIdx = headers.indexOf("fulfillment-channel");
          const statusIdx = headers.indexOf("status");
          for (const line of lines.slice(1)) {
            const parts = line.split(";");
            if (parts.length < headers.length) continue;
            const sku = parts[skuIdx];
            if (!sku) continue;
            const price = Number.parseFloat((parts[priceIdx] || "0").replace(",", ".")) || 0;
            const name = parts[nameIdx] || "";
            catalogPriceMap.set(sku, { price, name });
            if (parts[channelIdx] === "DEFAULT" && parts[statusIdx] === "Active") {
              const quantity = Number.parseInt(parts[qtyIdx], 10) || 0;
              fbmRows.push({
                sku,
                asin: parts[asinIdx] || "",
                name,
                total: quantity,
                fulfillable: quantity,
                reserved: 0,
                inbound: 0,
                price,
                fulfillmentChannel: "FBM",
                status: "Active",
              });
            }
          }
        }
      } catch (err) {
        console.warn("Error leyendo precios de catalogo_completo.csv:", err);
      }
    }

    // 3. Si existe inventario_fba.csv, usarlo como fuente principal de filas con datos reales de FBA
    if (targetFbaPath) {
      try {
        const text = fs.readFileSync(targetFbaPath, "utf-8");
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
            const sku = parts[skuIdx];
            if (!sku) continue;

            const catInfo = catalogPriceMap.get(sku);
            const rawName = (nameIdx !== -1 ? parts[nameIdx] : "") || catInfo?.name || "";

            rows.push({
              sku,
              asin: (asinIdx !== -1 ? parts[asinIdx] : "") || "",
              name: rawName,
              total: totalIdx !== -1 ? Number.parseInt(parts[totalIdx], 10) || 0 : 0,
              fulfillable: dispIdx !== -1 ? Number.parseInt(parts[dispIdx], 10) || 0 : 0,
              reserved: resIdx !== -1 ? Number.parseInt(parts[resIdx], 10) || 0 : 0,
              inbound: inbIdx !== -1 ? Number.parseInt(parts[inbIdx], 10) || 0 : 0,
              price: catInfo?.price ?? 0,
              fulfillmentChannel: "FBA",
              status: "Active",
            });
          }

          if (rows.length > 0) {
            return this.withFbmRows(includePrices ? await this.withMarketplacePrices(rows, marketplaceId) : rows, fbmRows);
          }
        }
      } catch (err) {
        console.warn("Error parseando inventario_fba.csv para rows:", err);
      }
    }

    // 4. Fallback directo a SP-API summaries si no hay CSV local
    const rows: InventoryRow[] = [];
    let nextToken: string | undefined;

    do {
      const response = await getInventorySummaries(this.client, {
        marketplaceIds: this.marketplaceIds,
        nextToken,
      });
      rows.push(
        ...response.payload.inventorySummaries.map((summary) => {
          const catInfo = catalogPriceMap.get(summary.sellerSku);
          const base = toRow(summary);
          return {
            ...base,
            name: catInfo?.name || "",
            price: catInfo?.price ?? 0,
            fulfillmentChannel: "FBA" as const,
            status: "Active",
          };
        })
      );
      nextToken = response.pagination?.nextToken;
    } while (nextToken);

    return this.withFbmRows(includePrices ? await this.withMarketplacePrices(rows, marketplaceId) : rows, fbmRows);
  }

  /**
   * Añade los listings FBM activos. Mantienen el precio del catálogo: pedir
   * getPricing para ~10k ASINs (lotes de 20) haría el snapshot inviable.
   */
  private withFbmRows(fbaRows: InventoryRow[], fbmRows: InventoryRow[]): InventoryRow[] {
    const fbaSkus = new Set(fbaRows.map((row) => row.sku));
    return [...fbaRows, ...fbmRows.filter((row) => !fbaSkus.has(row.sku))];
  }

  private async withMarketplacePrices(rows: InventoryRow[], marketplaceId: string): Promise<InventoryRow[]> {
    const priceByAsin = new Map<string, number>();
    for (let i = 0; i < rows.length; i += 20) {
      const chunk = rows.slice(i, i + 20).filter((row) => row.asin).map((row) => row.asin);
      if (!chunk.length) continue;
      try {
        const response = await getPricing(this.client, { marketplaceId, asins: chunk, itemType: "Asin" });
        for (const item of response.payload || []) {
          const asin = String(item.ASIN || "");
          const product = (item.Product || {}) as Record<string, unknown>;
          const offers = Array.isArray(product.Offers) ? product.Offers as Array<Record<string, unknown>> : [];
          const own = offers.find((offer) => String(offer.SellerId || "") === this.sellerId) || offers[0];
          const listing = own?.BuyingPrice as Record<string, unknown> | undefined;
          const amount = (listing?.ListingPrice as Record<string, unknown> | undefined)?.Amount;
          if (asin && typeof amount === "number") priceByAsin.set(asin, amount);
        }
      } catch (error) {
        console.warn(`No se pudieron cargar precios del marketplace ${marketplaceId}:`, error);
      }
    }
    return rows.map((row) => ({ ...row, price: priceByAsin.get(row.asin) ?? 0 }));
  }
}

function toRow(summary: InventorySummary): InventoryRow {
  const details = summary.inventoryDetails;
  return {
    sku: summary.sellerSku,
    asin: summary.asin,
    fulfillable: details?.fulfillableQuantity ?? 0,
    reserved: details?.reservedQuantity?.totalReservedQuantity ?? 0,
    inbound:
      (details?.inboundWorkingQuantity ?? 0) +
      (details?.inboundShippedQuantity ?? 0) +
      (details?.inboundReceivingQuantity ?? 0),
  };
}
