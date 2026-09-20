import type { Request, Response } from "express";
import type { AccountHealthService } from "./account-health.service";

export class AccountHealthController {
  constructor(private readonly service: AccountHealthService) {}

  getSnapshot = async (req: Request, res: Response): Promise<void> => {
    try {
      const force = req.query.force === "true";
      const snapshot = await this.service.getAccountHealth(force);
      res.json(snapshot);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "account_health_error", message });
    }
  };
}
