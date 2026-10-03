import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import type { SearchFunnelController } from "./searchFunnel.controller";

export function buildBrandAnalyticsRouter(controller: SearchFunnelController): Router {
  const router = Router();
  router.get("/search-funnel", asyncHandler(controller.getSearchFunnel));
  router.get("/search-funnel/sync", asyncHandler(controller.getSyncStatus));
  router.post("/search-funnel/sync", asyncHandler(controller.startSync));
  return router;
}
