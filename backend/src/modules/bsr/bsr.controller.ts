import type { Request, Response } from "express";
import { BSR_MARKETPLACES, type BsrMarketplace, findBsrMarketplace } from "./bsr.marketplaces";
import type { BsrService } from "./bsr.service";

export class BsrController {
  constructor(private readonly bsrService: BsrService) {}

  /** ?marketplace=DE; sin parámetro usa el marketplace por defecto. Responde 400 si no es válido. */
  private resolveMarketplace(req: Request, res: Response): BsrMarketplace | null {
    const code = typeof req.query.marketplace === "string" ? req.query.marketplace : "";
    if (!code) return this.bsrService.defaultMarketplace;
    const marketplace = findBsrMarketplace(code);
    if (!marketplace) {
      res.status(400).json({
        error: "invalid_marketplace",
        message: `Marketplace no soportado: ${code}. Usa ${BSR_MARKETPLACES.map((m) => m.code).join(", ")}.`,
      });
      return null;
    }
    return marketplace;
  }

  getCatalog = async (req: Request, res: Response): Promise<void> => {
    const marketplace = this.resolveMarketplace(req, res);
    if (!marketplace) return;
    const list = await this.bsrService.getCatalogBsr(marketplace, req.query.fetchAll === "true");
    res.json(list);
  };

  getProductHistory = async (req: Request, res: Response): Promise<void> => {
    const asin = String(req.params.asin || "");
    const days = parseInt(String(req.query.days || "60"), 10) || 60;

    if (!asin) {
      res.status(400).json({ error: "missing_asin" });
      return;
    }
    const marketplace = this.resolveMarketplace(req, res);
    if (!marketplace) return;

    const history = await this.bsrService.getProductBsrHistory(asin, days, marketplace);
    res.json(history);
  };

  getWeekly = async (req: Request, res: Response): Promise<void> => {
    const marketplace = this.resolveMarketplace(req, res);
    if (!marketplace) return;
    res.json(await this.bsrService.getWeeklyTopProducts(marketplace));
  };

  refreshProduct = async (req: Request, res: Response): Promise<void> => {
    const asin = String(req.params.asin || "");
    if (!asin) {
      res.status(400).json({ error: "missing_asin" });
      return;
    }
    const marketplace = this.resolveMarketplace(req, res);
    if (!marketplace) return;

    const snap = await this.bsrService.refreshProductBsr(asin, marketplace);
    res.json(snap);
  };
}
