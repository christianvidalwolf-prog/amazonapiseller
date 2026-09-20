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

  getSummary = async (req: Request, res: Response): Promise<void> => {
    try {
      const start = typeof req.query.start === "string" ? req.query.start : undefined;
      const end = typeof req.query.end === "string" ? req.query.end : undefined;
      const summary = await this.service.getSummary(start, end);
      res.json(summary);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "ads_summary_error", message });
    }
  };

  getCampaigns = async (_req: Request, res: Response): Promise<void> => {
    try {
      const campaigns = await this.service.getCampaigns();
      res.json({ campaigns });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "ads_campaigns_error", message });
    }
  };
}
