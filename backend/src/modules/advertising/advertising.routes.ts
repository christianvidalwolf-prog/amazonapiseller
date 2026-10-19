import { Router } from "express";
import type { AdvertisingController } from "./advertising.controller";

export function buildAdvertisingRouter(controller: AdvertisingController): Router {
  const router = Router();

  router.get("/status", controller.getStatus);
  router.get("/profiles", controller.getProfiles);
  router.get("/summary", controller.getSummary);
  router.get("/campaigns", controller.getCampaigns);
  router.get("/profitability", controller.getProfitability);
  router.get("/keywords/harvest", controller.getKeywordHarvest);
  router.patch("/keywords/harvest", controller.decideNegative);
  router.get("/changelog", controller.getChangeLog);

  return router;
}
