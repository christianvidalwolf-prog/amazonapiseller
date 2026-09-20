import type { Request, Response } from "express";
import type { BsrService } from "./bsr.service";

export class BsrController {
  constructor(private readonly bsrService: BsrService) {}

  getCatalog = async (_req: Request, res: Response): Promise<void> => {
    const list = await this.bsrService.getCatalogBsr();
    res.json(list);
  };

  getProductHistory = async (req: Request, res: Response): Promise<void> => {
    const asin = String(req.params.asin || "");
    const days = parseInt(String(req.query.days || "60"), 10) || 60;

    if (!asin) {
      res.status(400).json({ error: "missing_asin" });
      return;
    }

    const history = await this.bsrService.getProductBsrHistory(asin, days);
    res.json(history);
  };

  refreshProduct = async (req: Request, res: Response): Promise<void> => {
    const asin = String(req.params.asin || "");
    if (!asin) {
      res.status(400).json({ error: "missing_asin" });
      return;
    }

    const snap = await this.bsrService.refreshProductBsr(asin);
    res.json(snap);
  };
}
