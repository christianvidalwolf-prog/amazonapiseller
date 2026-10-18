import type { Request, Response } from "express";

/** ?country=DE (two uppercase letters) → that country's Ads profile; absent → default profile. */
function countryOf(req: Request, res: Response): string | undefined | null {
  const raw = req.query.country ?? (req.body as { country?: unknown } | undefined)?.country;
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw === "string" && /^[A-Z]{2}$/.test(raw.toUpperCase())) return raw.toUpperCase();
  res.status(400).json({ error: "invalid_country", message: "country debe ser un código de 2 letras (ES, DE, FR, IT…)" });
  return null;
}

import type { AdvertisingService } from "./advertising.service";
import { DecisionError, type NegativesService } from "./negatives.service";

export class AdvertisingController {
  constructor(
    private readonly service: AdvertisingService,
    private readonly negatives?: NegativesService
  ) {}

  getKeywordHarvest = async (req: Request, res: Response): Promise<void> => {
    const country = countryOf(req, res);
    if (country === null) return;
    if (!this.negatives) {
      res.status(501).json({ error: "negatives_not_configured" });
      return;
    }
    try {
      res.json(await this.negatives.getKeywordHarvest(country));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "ads_harvest_error", message });
    }
  };

  /** Body: { id: string, decision: "approved" | "rejected" }. Records a human decision; never touches Amazon. */
  decideNegative = async (req: Request, res: Response): Promise<void> => {
    const { id, decision } = (req.body ?? {}) as { id?: unknown; decision?: unknown };
    if (typeof id !== "string" || !id || (decision !== "approved" && decision !== "rejected")) {
      res.status(400).json({ error: "invalid_body", message: "Se requiere { id: string, decision: 'approved' | 'rejected' }" });
      return;
    }
    const country = countryOf(req, res);
    if (country === null) return;
    if (!this.negatives) {
      res.status(501).json({ error: "negatives_not_configured" });
      return;
    }
    try {
      res.json(await this.negatives.decide(id, decision, country));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(err instanceof DecisionError ? err.statusCode : 500).json({ error: "ads_decision_error", message });
    }
  };

  getStatus = async (_req: Request, res: Response): Promise<void> => {
    try {
      const status = await this.service.getConnectionStatus();
      res.json(status);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "ads_status_error", message });
    }
  };

  getProfiles = async (_req: Request, res: Response): Promise<void> => {
    try {
      const profiles = await this.service.getProfiles();
      res.json(profiles);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "ads_profiles_error", message });
    }
  };

  getSummary = async (req: Request, res: Response): Promise<void> => {
    const country = countryOf(req, res);
    if (country === null) return;
    try {
      res.json(await this.service.getSummary(country));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "ads_summary_error", message });
    }
  };

  getProfitability = async (req: Request, res: Response): Promise<void> => {
    const country = countryOf(req, res);
    if (country === null) return;
    try {
      res.json(await this.service.getProfitability(country));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "ads_profitability_error", message });
    }
  };

  getCampaigns = async (req: Request, res: Response): Promise<void> => {
    const country = countryOf(req, res);
    if (country === null) return;
    try {
      res.json(await this.service.getCampaigns(country));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "ads_campaigns_error", message });
    }
  };
}
