import type { Request, Response } from "express";
import type { PricingService } from "./pricing.service";

export class PricingController {
  constructor(private readonly service: PricingService) {}

  getSummary = async (req: Request, res: Response): Promise<void> => {
    try {
      // 0 significa catálogo completo; se mantiene el parámetro para poder
      // limitar manualmente las consultas si el vendedor lo necesita.
      const limit = req.query.limit ? Number(req.query.limit) : 0;
      const force = req.query.force === "true";
      const summary = await this.service.getCompetitivePricingSummary(limit, force);
      res.json(summary);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "pricing_summary_error", message });
    }
  };

  getOffers = async (req: Request, res: Response): Promise<void> => {
    try {
      const asin = req.query.asin ? String(req.query.asin).trim() : "";
      if (!asin) {
        res.status(400).json({ error: "missing_asin", message: "Se requiere el parámetro 'asin'" });
        return;
      }
      const detail = await this.service.getProductOffersDetail(asin);
      res.json(detail);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "product_offers_error", message });
    }
  };
}
