import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import type { BsrController } from "./bsr.controller";

export function buildBsrRouter(controller: BsrController): Router {
  const router = Router();
  router.get("/catalog", asyncHandler(controller.getCatalog));
  router.get("/history/:asin", asyncHandler(controller.getProductHistory));
  router.post("/refresh/:asin", asyncHandler(controller.refreshProduct));
  return router;
}
