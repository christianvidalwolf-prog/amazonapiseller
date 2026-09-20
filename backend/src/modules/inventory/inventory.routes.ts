import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import type { InventoryController } from "./inventory.controller";

export function buildInventoryRouter(controller: InventoryController): Router {
  const router = Router();
  router.get("/snapshot", asyncHandler(controller.getSnapshot));
  return router;
}
