import type { Request, Response } from "express";
import type { AccountHealthService } from "./account-health.service";

export class AccountHealthController {
  constructor(private readonly service: AccountHealthService) {}

  getSnapshot = async (req: Request, res: Response): Promise<void> => {
    try {
      const marketplaceId = req.query.marketplaceId as string;
      const force = req.query.force === "true";
      const snapshot = await this.service.getAccountHealth(marketplaceId, force);
      res.json(snapshot);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "account_health_error", message });
    }
  };

  getNegatives = async (req: Request, res: Response): Promise<void> => {
    try {
      const marketplaceId = req.query.marketplaceId as string;
      const force = req.query.force === "true";
      res.json(await this.service.getNegativeFeedback(marketplaceId, force));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "account_health_error", message });
    }
  };

  getFeedback = async (req: Request, res: Response): Promise<void> => {
    try {
      const feedback = await this.service.fetchRecentCustomerFeedback();
      res.json({ feedback });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "customer_feedback_error", message });
    }
  };
}
