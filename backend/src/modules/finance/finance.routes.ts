import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import type { FinanceController } from "./finance.controller";

export function buildFinanceRouter(controller: FinanceController): Router {
  const router = Router();
  router.get("/summary", asyncHandler(controller.getSummary));
  router.get("/annual", asyncHandler(controller.getAnnual));
  router.get("/expenses", asyncHandler(controller.listExpenses));
  router.post("/expenses", asyncHandler(controller.addExpense));
  router.delete("/expenses/:id", asyncHandler(controller.deleteExpense));
  router.get("/costs", asyncHandler(controller.listCosts));
  router.post("/costs", asyncHandler(controller.upsertCost));
  router.post("/costs/bulk", asyncHandler(controller.bulkUpsertCosts));
  router.delete("/costs/:sku", asyncHandler(controller.deleteCost));
  return router;
}
