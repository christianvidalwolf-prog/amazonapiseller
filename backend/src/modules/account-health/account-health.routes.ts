import { Router } from "express";
import type { AccountHealthController } from "./account-health.controller";

export function buildAccountHealthRouter(controller: AccountHealthController): Router {
  const router = Router();

  router.get("/summary", controller.getSnapshot);
  router.get("/negatives", controller.getNegatives);
  router.get("/feedback", controller.getFeedback);

  return router;
}
