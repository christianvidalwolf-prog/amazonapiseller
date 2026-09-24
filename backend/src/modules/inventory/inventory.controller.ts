import type { Request, Response } from "express";
import type { InventoryService } from "./inventory.service";

export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  getSnapshot = async (req: Request, res: Response): Promise<void> => {
    const marketplaceId = typeof req.query.marketplaceId === "string" ? req.query.marketplaceId : undefined;
    const includePrices = req.query.includePrices !== "false";
    const rows = await this.inventoryService.getInventorySnapshot(marketplaceId, includePrices);
    res.json({ rows });
  };
}
