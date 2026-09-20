-- CreateTable
CREATE TABLE "SellingPartnerAccount" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "marketplaceIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellingPartnerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesTrafficDaily" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "unitsOrdered" INTEGER NOT NULL,
    "netSales" DECIMAL(12,2) NOT NULL,
    "sessions" INTEGER NOT NULL,
    "pageViews" INTEGER NOT NULL,
    "buyBoxPercentage" DECIMAL(5,2) NOT NULL,
    "unitSessionPercentage" DECIMAL(5,2) NOT NULL,

    CONSTRAINT "SalesTrafficDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventorySnapshot" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "fulfillableQuantity" INTEGER NOT NULL,
    "reservedQuantity" INTEGER NOT NULL,
    "inboundQuantity" INTEGER NOT NULL,
    "avgDailyUnitsSold30d" DECIMAL(10,2) NOT NULL,
    "daysOfCover" DECIMAL(10,2),
    "isStranded" BOOLEAN NOT NULL DEFAULT false,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventorySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceHistory" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "ourPrice" DECIMAL(10,2) NOT NULL,
    "buyBoxPrice" DECIMAL(10,2),
    "hasBuyBox" BOOLEAN NOT NULL,
    "competitorCount" INTEGER NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingAlert" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "PricingAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialEvent" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "sku" TEXT,
    "orderId" TEXT,
    "eventType" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "postedDate" TIMESTAMP(3) NOT NULL,
    "rawPayload" JSONB NOT NULL,

    CONSTRAINT "FinancialEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitEconomics" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "period" DATE NOT NULL,
    "sellingPrice" DECIMAL(10,2) NOT NULL,
    "cogs" DECIMAL(10,2) NOT NULL,
    "fbaFees" DECIMAL(10,2) NOT NULL,
    "referralFee" DECIMAL(10,2) NOT NULL,
    "advertisingCost" DECIMAL(10,2) NOT NULL,
    "netMargin" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "UnitEconomics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountHealthSnapshot" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "orderDefectRate" DECIMAL(5,2) NOT NULL,
    "lateShipmentRate" DECIMAL(5,2) NOT NULL,
    "cancellationRate" DECIMAL(5,2) NOT NULL,
    "negativeFeedbackCount" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountHealthSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingSubmission" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "issues" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SellingPartnerAccount_sellerId_key" ON "SellingPartnerAccount"("sellerId");

-- CreateIndex
CREATE INDEX "SalesTrafficDaily_sellerId_date_idx" ON "SalesTrafficDaily"("sellerId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "SalesTrafficDaily_sellerId_marketplaceId_sku_date_key" ON "SalesTrafficDaily"("sellerId", "marketplaceId", "sku", "date");

-- CreateIndex
CREATE INDEX "InventorySnapshot_sellerId_sku_capturedAt_idx" ON "InventorySnapshot"("sellerId", "sku", "capturedAt");

-- CreateIndex
CREATE INDEX "PriceHistory_sellerId_asin_recordedAt_idx" ON "PriceHistory"("sellerId", "asin", "recordedAt");

-- CreateIndex
CREATE INDEX "PricingAlert_sellerId_createdAt_idx" ON "PricingAlert"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "FinancialEvent_sellerId_sku_postedDate_idx" ON "FinancialEvent"("sellerId", "sku", "postedDate");

-- CreateIndex
CREATE UNIQUE INDEX "UnitEconomics_sellerId_sku_period_key" ON "UnitEconomics"("sellerId", "sku", "period");

-- CreateIndex
CREATE INDEX "AccountHealthSnapshot_sellerId_capturedAt_idx" ON "AccountHealthSnapshot"("sellerId", "capturedAt");

-- CreateIndex
CREATE INDEX "ListingSubmission_sku_createdAt_idx" ON "ListingSubmission"("sku", "createdAt");
