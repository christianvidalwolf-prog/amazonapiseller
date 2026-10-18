import type { Request, Response } from "express";
import type { AdvertisingService } from "./advertising.service";

export class AdvertisingController {
  constructor(private readonly service: AdvertisingService) {}

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

  getSummary = async (_req: Request, res: Response): Promise<void> => {
    try {
      res.json(await this.service.getSummary());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "ads_summary_error", message });
    }
  };

  getProfitability = async (_req: Request, res: Response): Promise<void> => {
    try {
      res.json(await this.service.getProfitability());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "ads_profitability_error", message });
    }
  };

  getCampaigns = async (_req: Request, res: Response): Promise<void> => {
    try {
      res.json(await this.service.getCampaigns());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "ads_campaigns_error", message });
    }
  };
}
