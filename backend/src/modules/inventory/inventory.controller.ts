import type { Request, Response } from "express";
import type { InventoryService } from "./inventory.service";

export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  getSnapshot = async (_req: Request, res: Response): Promise<void> => {
    const rows = await this.inventoryService.getInventorySnapshot();
    res.json({ rows });
  };
}
