-- CreateTable
CREATE TABLE "ManualExpense" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "allocationType" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "period" DATE NOT NULL,
    "orderId" TEXT,
    "sku" TEXT,
    "quantity" DECIMAL(12,3),
    "unitAmount" DECIMAL(12,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualExpense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ManualExpense_sellerId_period_idx" ON "ManualExpense"("sellerId", "period");

-- CreateIndex
CREATE INDEX "ManualExpense_sellerId_category_period_idx" ON "ManualExpense"("sellerId", "category", "period");

-- CreateIndex
CREATE INDEX "ManualExpense_sellerId_orderId_idx" ON "ManualExpense"("sellerId", "orderId");

-- CreateIndex
CREATE INDEX "ManualExpense_sellerId_sku_period_idx" ON "ManualExpense"("sellerId", "sku", "period");
