import { Router } from "express";
import type { SyncController } from "./sync.controller";

export function buildSyncRouter(controller: SyncController): Router {
  const router = Router();

  router.get("/status", controller.getStatus);
  router.post("/trigger", controller.trigger);
  router.post("/config", controller.updateConfig);

  return router;
}
