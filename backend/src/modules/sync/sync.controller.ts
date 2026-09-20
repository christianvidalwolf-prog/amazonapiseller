import type { Request, Response } from "express";
import type { SyncService } from "./sync.service";

export class SyncController {
  constructor(private readonly service: SyncService) {}

  getStatus = (_req: Request, res: Response): void => {
    const status = this.service.getStatus();
    res.json(status);
  };

  trigger = async (req: Request, res: Response): Promise<void> => {
    const scope = (req.body?.scope as "all" | "inventory" | "sales") || "all";
    const result = await this.service.triggerSync(scope);
    if (!result.started) {
      res.status(409).json(result);
      return;
    }
    res.status(202).json(result);
  };

  updateConfig = (req: Request, res: Response): void => {
    const intervalMinutes = req.body?.intervalMinutes ? Number(req.body.intervalMinutes) : undefined;
    const autoSyncEnabled = typeof req.body?.autoSyncEnabled === "boolean" ? req.body.autoSyncEnabled : undefined;

    const newStatus = this.service.setConfig({ intervalMinutes, autoSyncEnabled });
    res.json(newStatus);
  };
}
