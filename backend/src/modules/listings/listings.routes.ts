import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { ListingsController } from "./listings.controller";

export function buildListingsRouter(controller: ListingsController): Router {
  const router = Router();

  router.get("/", asyncHandler(controller.getListings));
  router.get("/product-types/:productType/schema", asyncHandler(controller.getSchema));
  router.post("/items/:sku/validate", asyncHandler(controller.validate));
  router.put("/items/:sku", asyncHandler(controller.submit));
  router.post("/batch", asyncHandler(controller.submitBatch));
  router.get("/batch/:feedId", asyncHandler(controller.batchStatus));

  return router;
}
