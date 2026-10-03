import type { Request, Response } from "express";
import { parseCostsCsv, type CostRow, type FinanceService } from "./finance.service";

export class FinanceController {
  constructor(private readonly financeService: FinanceService) {}

  getSummary = async (req: Request, res: Response): Promise<void> => {
    const postedAfter = typeof req.query.postedAfter === "string" ? req.query.postedAfter : undefined;
    const forceRefresh = req.query.refresh === "true";

    const summary = await this.financeService.getFinanceSummary(postedAfter, forceRefresh);
    res.json(summary);
  };

  listExpenses = async (req: Request, res: Response): Promise<void> => {
    const period = typeof req.query.period === "string" ? req.query.period : undefined;
    res.json(await this.financeService.listManualExpenses(period));
  };

  addExpense = async (req: Request, res: Response): Promise<void> => {
    const body = req.body || {};
    if (!body.category || !body.description || !body.allocationType || body.amount === undefined || !/^\d{4}-\d{2}$/.test(body.period || "")) {
      res.status(400).json({ error: "category, description, allocationType, amount and period (YYYY-MM) are required" });
      return;
    }
    res.status(201).json(await this.financeService.addManualExpense(body));
  };

  deleteExpense = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.financeService.deleteManualExpense(req.params.id));
  };

  getAnnual = async (req: Request, res: Response): Promise<void> => {
    const year = Number(req.query.year || new Date().getUTCFullYear());
    if (!Number.isInteger(year) || year < 2000 || year > 2100) { res.status(400).json({ error: "year must be valid" }); return; }
    res.json(await this.financeService.getAnnualFinanceSummary(year, req.query.refresh === "true"));
  };

  listCosts = async (_req: Request, res: Response): Promise<void> => {
    res.json(await this.financeService.listCosts());
  };

  upsertCost = async (req: Request, res: Response): Promise<void> => {
    const body = req.body || {};
    if (!body.sku || body.unitCost === undefined || !Number.isFinite(Number(body.unitCost)) || Number(body.unitCost) < 0) {
      res.status(400).json({ error: "sku and a valid unitCost are required" });
      return;
    }
    res.status(201).json(await this.financeService.upsertCost({
      sku: String(body.sku), unitCost: Number(body.unitCost), currency: body.currency, source: "manual",
    }));
  };

  bulkUpsertCosts = async (req: Request, res: Response): Promise<void> => {
    const body = req.body || {};
    let rows: CostRow[] = [];
    let parseErrors: string[] = [];
    if (typeof body.csv === "string") {
      ({ rows, errors: parseErrors } = parseCostsCsv(body.csv));
    } else if (Array.isArray(body.rows)) {
      rows = body.rows;
    } else {
      res.status(400).json({ error: "Provide csv (string) or rows (array)" });
      return;
    }
    const result = await this.financeService.bulkUpsertCosts(rows);
    res.json({ ...result, parseErrors });
  };

  deleteCost = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.financeService.deleteCost(req.params.sku));
  };

  getReimbursementsAudit = async (req: Request, res: Response): Promise<void> => {
    const country = typeof req.query.country === "string" ? req.query.country : "ALL";
    const summary = await this.financeService.getReimbursementsAudit(country);
    res.json(summary);
  };
}
