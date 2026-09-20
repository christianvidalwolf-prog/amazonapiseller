import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import type { FinanceController } from "./finance.controller";

export function buildFinanceRouter(controller: FinanceController): Router {
  const router = Router();
  router.get("/summary", asyncHandler(controller.getSummary));
  return router;
}
