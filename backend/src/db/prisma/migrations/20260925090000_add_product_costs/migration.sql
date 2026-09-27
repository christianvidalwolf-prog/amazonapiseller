-- CreateTable
CREATE TABLE "ProductCost" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductCost_sellerId_sku_idx" ON "ProductCost"("sellerId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCost_sellerId_sku_key" ON "ProductCost"("sellerId", "sku");
