import type { Request, Response } from "express";
import type { SalesService } from "./sales.service";

function firstOfMonthUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  getSummary = async (req: Request, res: Response): Promise<void> => {
    // Si no se especifica start, cargar todo el año 2026
    const dataStartTime = typeof req.query.start === "string" ? req.query.start : "2026-01-01T00:00:00.000Z";
    const dataEndTime = typeof req.query.end === "string" ? req.query.end : new Date().toISOString();

    const report = await this.salesService.getSalesReport(dataStartTime, dataEndTime);
    res.json(report);
  };

  getPeriodDetails = async (req: Request, res: Response): Promise<void> => {
    const start = typeof req.query.start === "string" ? req.query.start : "";
    const end = typeof req.query.end === "string" ? req.query.end : start;
    const channel = typeof req.query.channel === "string" ? req.query.channel : "ALL";

    if (!start) {
      res.status(400).json({ error: "missing_start_param", message: "Se requiere el parámetro 'start'" });
      return;
    }

    const details = await this.salesService.getPeriodDetails(start, end, channel);
    res.json(details);
  };
}
