import type { Request, Response } from "express";
import type { FinanceService } from "./finance.service";

export class FinanceController {
  constructor(private readonly financeService: FinanceService) {}

  getSummary = async (req: Request, res: Response): Promise<void> => {
    const postedAfter = typeof req.query.postedAfter === "string" ? req.query.postedAfter : undefined;
    const forceRefresh = req.query.refresh === "true";

    const summary = await this.financeService.getFinanceSummary(postedAfter, forceRefresh);
    res.json(summary);
  };
}
