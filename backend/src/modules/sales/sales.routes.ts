import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import type { SalesController } from "./sales.controller";

export function buildSalesRouter(controller: SalesController): Router {
  const router = Router();
  router.get("/summary", asyncHandler(controller.getSummary));
  return router;
}
