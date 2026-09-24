import type { Request, Response } from "express";
import type { InventoryService } from "./inventory.service";

export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  getSnapshot = async (req: Request, res: Response): Promise<void> => {
    const marketplaceId = typeof req.query.marketplaceId === "string" ? req.query.marketplaceId : undefined;
    const rows = await this.inventoryService.getInventorySnapshot(marketplaceId);
    res.json({ rows });
  };
}
