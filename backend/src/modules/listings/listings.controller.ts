import type { Request, Response } from "express";
import { ListingsService } from "./listings.service";
import { SpApiError } from "../../spapi/types";
import { readCatalogCsvLines } from "../../lib/catalogCsv";

export class ListingsController {
  constructor(private readonly listingsService: ListingsService) {}

  getSchema = async (req: Request, res: Response): Promise<void> => {
    const { productType, marketplaceId } = req.params;
    const schema = await this.listingsService.getProductTypeSchema(productType, marketplaceId);
    res.json(schema);
  };

  validate = async (req: Request, res: Response): Promise<void> => {
    const { sku } = req.params;
    const result = await this.listingsService.validateListing(sku, req.body);
    res.status(result.valid ? 200 : 422).json(result);
  };

  submit = async (req: Request, res: Response): Promise<void> => {
    try {
      const { sku } = req.params;
      const result = await this.listingsService.submitListingItem(sku, req.body);
      res.status(result.status === "INVALID" ? 422 : 202).json(result);
    } catch (error) {
      if (ListingsService.isValidationError(error)) {
        const spError = error as SpApiError;
        res.status(spError.statusCode).json({ errors: spError.errors });
        return;
      }
      throw error;
    }
  };

  quickUpdate = async (req: Request, res: Response): Promise<void> => {
    try {
      const { sku } = req.params;
      const { price, stock, leadTimeDays, marketplaceId, currency } = req.body;
      const result = await this.listingsService.updatePriceOrStock({
        sku,
        price: typeof price === "number" ? price : price ? Number.parseFloat(price) : undefined,
        stock: typeof stock === "number" ? stock : stock ? Number.parseInt(stock, 10) : undefined,
        leadTimeDays: leadTimeDays ? Number.parseInt(leadTimeDays, 10) : undefined,
        marketplaceId,
        currency,
      });
      res.status(result.status === "INVALID" ? 422 : 200).json(result);
    } catch (error) {
      if (ListingsService.isValidationError(error)) {
        const spError = error as SpApiError;
        res.status(spError.statusCode).json({ errors: spError.errors });
        return;
      }
      res.status(500).json({ error: error instanceof Error ? error.message : "Error al actualizar listing" });
    }
  };

  submitBatch = async (req: Request, res: Response): Promise<void> => {
    const { messages } = req.body as { messages: Parameters<ListingsService["submitListingsBatch"]>[0] };
    const result = await this.listingsService.submitListingsBatch(messages);
    res.status(202).json(result);
  };

  batchStatus = async (req: Request, res: Response): Promise<void> => {
    const result = await this.listingsService.getBatchStatus(req.params.feedId);
    res.json(result);
  };

  getListings = async (req: Request, res: Response): Promise<void> => {
    const fs = await import("node:fs");
    const path = await import("node:path");

    // 1. Intentar cargar el catálogo completo (FBA + FBM + Inactivos)
    const fullCatalogPath = path.resolve(process.cwd(), "..", "catalogo_completo.csv");
    const altFullCatalogPath = path.resolve(process.cwd(), "catalogo_completo.csv");
    const targetCatalogPath = fs.existsSync(fullCatalogPath)
      ? fullCatalogPath
      : fs.existsSync(altFullCatalogPath)
      ? altFullCatalogPath
      : null;

    if (targetCatalogPath) {
      try {
        const lines = readCatalogCsvLines(targetCatalogPath);
        if (lines.length > 1) {
          const headers = lines[0].replace(/^\uFEFF/, "").replace(/^[^\w]+/, "").split(";");
          const skuIdx = headers.indexOf("seller-sku");
          const asinIdx = headers.indexOf("asin1");
          const nameIdx = headers.indexOf("item-name");
          const priceIdx = headers.indexOf("price");
          const qtyIdx = headers.indexOf("quantity");
          const statusIdx = headers.indexOf("status");
          const channelIdx = headers.indexOf("fulfillment-channel");

          const items = [];
          for (const line of lines.slice(1)) {
            const parts = line.split(";");
            if (parts.length < headers.length) continue;
            const sku = parts[skuIdx] || "";
            if (!sku) continue;

            const fulfillment = parts[channelIdx] === "AMAZON_EU" ? "FBA" : "FBM";
            const qty = Number.parseInt(parts[qtyIdx], 10) || 0;
            const price = Number.parseFloat((parts[priceIdx] || "0").replace(",", ".")) || 0;

            items.push({
              sku,
              asin: parts[asinIdx] || "",
              fnsku: "",
              name: parts[nameIdx] || "",
              total: qty,
              fulfillable: qty,
              price,
              status: parts[statusIdx] || "Active",
              fulfillmentChannel: fulfillment,
            });
          }

          res.json({ items, total: items.length });
          return;
        }
      } catch (err) {
        console.warn("Error leyendo catalogo_completo.csv:", err);
      }
    }

    // 2. Fallback a inventario_fba.csv
    const csvPath = path.resolve(process.cwd(), "..", "inventario_fba.csv");
    const altCsvPath = path.resolve(process.cwd(), "inventario_fba.csv");
    const targetPath = fs.existsSync(csvPath) ? csvPath : fs.existsSync(altCsvPath) ? altCsvPath : null;

    if (!targetPath) {
      res.json({ items: [], total: 0 });
      return;
    }

    const text = fs.readFileSync(targetPath, "utf-8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const headers = lines[0].replace(/^\uFEFF/, "").split(";");
    const skuIdx = headers.indexOf("SKU");
    const asinIdx = headers.indexOf("ASIN");
    const fnskuIdx = headers.indexOf("FNSKU");
    const nameIdx = headers.indexOf("Nombre");
    const totalIdx = headers.indexOf("Total");
    const dispIdx = headers.indexOf("Disponible");

    const items = [];
    for (const line of lines.slice(1)) {
      const parts = line.split(";");
      if (parts.length < headers.length) continue;
      items.push({
        sku: parts[skuIdx] || "",
        asin: parts[asinIdx] || "",
        fnsku: fnskuIdx !== -1 ? parts[fnskuIdx] : "",
        name: nameIdx !== -1 ? parts[nameIdx] : "",
        total: totalIdx !== -1 ? Number.parseInt(parts[totalIdx], 10) || 0 : 0,
        fulfillable: dispIdx !== -1 ? Number.parseInt(parts[dispIdx], 10) || 0 : 0,
        price: 0,
        status: "Active",
        fulfillmentChannel: "FBA",
      });
    }

    res.json({ items, total: items.length });
  };
}
