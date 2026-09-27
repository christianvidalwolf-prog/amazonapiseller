import { Router } from "express";
import type { PricingController } from "./pricing.controller";

export function buildPricingRouter(controller: PricingController): Router {
  const router = Router();

  router.get("/summary", controller.getSummary);
  router.get("/offers", controller.getOffers);
  router.get("/margin/:sku", controller.getMargin);
  router.get("/margins", controller.getMargins);

  return router;
}
