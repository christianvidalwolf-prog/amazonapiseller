import { Router } from "express";
import type { AdvertisingController } from "./advertising.controller";

export function buildAdvertisingRouter(controller: AdvertisingController): Router {
  const router = Router();

  router.get("/status", controller.getStatus);
  router.get("/profiles", controller.getProfiles);
  router.get("/summary", controller.getSummary);
  router.get("/campaigns", controller.getCampaigns);

  return router;
}
