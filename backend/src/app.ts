import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { env } from "./config/env";
import { prisma } from "./db/client";
import { SpApiClient } from "./spapi/client";
import { ListingsController } from "./modules/listings/listings.controller";
import { createPrismaListingSubmissionRepository } from "./modules/listings/listings.repository";
import { buildListingsRouter } from "./modules/listings/listings.routes";
import { ListingsService } from "./modules/listings/listings.service";
import { InventoryController } from "./modules/inventory/inventory.controller";
import { buildInventoryRouter } from "./modules/inventory/inventory.routes";
import { InventoryService } from "./modules/inventory/inventory.service";
import { SalesController } from "./modules/sales/sales.controller";
import { buildSalesRouter } from "./modules/sales/sales.routes";
import { SalesService } from "./modules/sales/sales.service";
import { FinanceController } from "./modules/finance/finance.controller";
import { buildFinanceRouter } from "./modules/finance/finance.routes";
import { FinanceService } from "./modules/finance/finance.service";
import { SyncService } from "./modules/sync/sync.service";
import { SyncController } from "./modules/sync/sync.controller";
import { buildSyncRouter } from "./modules/sync/sync.routes";
import { PricingService } from "./modules/pricing/pricing.service";
import { PricingController } from "./modules/pricing/pricing.controller";
import { buildPricingRouter } from "./modules/pricing/pricing.routes";
import { AccountHealthService } from "./modules/account-health/account-health.service";
import { AccountHealthController } from "./modules/account-health/account-health.controller";
import { buildAccountHealthRouter } from "./modules/account-health/account-health.routes";
import { AdsApiClient } from "./ads/adsClient";
import { AdvertisingService } from "./modules/advertising/advertising.service";
import { AdvertisingController } from "./modules/advertising/advertising.controller";
import { buildAdvertisingRouter } from "./modules/advertising/advertising.routes";
import { BsrService } from "./modules/bsr/bsr.service";
import { BsrController } from "./modules/bsr/bsr.controller";
import { buildBsrRouter } from "./modules/bsr/bsr.routes";

export function buildApp(): Express {
  const app = express();
  app.use(express.json());

  // CORS middleware for frontend (http://localhost:3000)
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    if (req.method === "OPTIONS") {
      res.sendStatus(200);
      return;
    }
    next();
  });

  const spApiClient = new SpApiClient({ credentials: env.spApi });

  const listingsService = new ListingsService(
    spApiClient,
    { sellerId: env.sellerId, marketplaceIds: env.marketplaceIds },
    createPrismaListingSubmissionRepository(prisma)
  );
  const listingsController = new ListingsController(listingsService);

  app.use("/api/listings", buildListingsRouter(listingsController));

  const inventoryService = new InventoryService(spApiClient, env.marketplaceIds, env.sellerId);
  const inventoryController = new InventoryController(inventoryService);
  app.use("/api/inventory", buildInventoryRouter(inventoryController));

  const salesService = new SalesService(spApiClient, env.marketplaceIds);
  const salesController = new SalesController(salesService);
  app.use("/api/sales", buildSalesRouter(salesController));

  const financeService = new FinanceService(spApiClient, prisma, env.sellerId);
  const financeController = new FinanceController(financeService);
  app.use("/api/finance", buildFinanceRouter(financeController));

  const syncService = new SyncService();
  const syncController = new SyncController(syncService);
  app.use("/api/sync", buildSyncRouter(syncController));

  const pricingService = new PricingService(spApiClient, env.marketplaceIds[0], env.sellerId);
  const pricingController = new PricingController(pricingService);
  app.use("/api/pricing", buildPricingRouter(pricingController));

  const accountHealthService = new AccountHealthService(spApiClient, env.marketplaceIds);
  const accountHealthController = new AccountHealthController(accountHealthService);
  app.use("/api/account-health", buildAccountHealthRouter(accountHealthController));

  const adsApiClient = new AdsApiClient({
    lwaClientId: env.adsApi.lwaClientId,
    lwaClientSecret: env.adsApi.lwaClientSecret,
    refreshToken: env.adsApi.refreshToken,
    profileId: env.adsApi.profileId,
    region: env.adsApi.region,
  });
  const advertisingService = new AdvertisingService(
    adsApiClient,
    salesService,
    env.marketplaceIds[0],
    env.adsApi.profileId
  );
  const advertisingController = new AdvertisingController(advertisingService);
  app.use("/api/advertising", buildAdvertisingRouter(advertisingController));

  const bsrService = new BsrService(spApiClient, env.marketplaceIds[0]);
  const bsrController = new BsrController(bsrService);
  app.use("/api/bsr", buildBsrRouter(bsrController));

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

  // Other modules (pricing, finance, account-health) mount their routers
  // here once implemented — see src/modules/<name>/README.md.

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // eslint-disable-next-line no-console
    console.error(error);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
