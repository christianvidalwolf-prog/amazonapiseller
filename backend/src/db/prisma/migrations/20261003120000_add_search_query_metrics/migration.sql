-- CreateTable
CREATE TABLE "search_query_metrics" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "marketplace_id" TEXT NOT NULL,
    "report_period" TEXT NOT NULL,
    "query_text" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "total_query_volume" INTEGER NOT NULL,
    "total_impressions" INTEGER NOT NULL,
    "total_clicks" INTEGER NOT NULL,
    "total_cart_adds" INTEGER NOT NULL,
    "total_purchases" INTEGER NOT NULL,
    "median_price" DECIMAL(12,2),
    "asin_median_price" DECIMAL(12,2),
    "currency" TEXT,
    "asin_impressions" INTEGER NOT NULL,
    "asin_impression_share" DOUBLE PRECISION NOT NULL,
    "asin_clicks" INTEGER NOT NULL,
    "asin_click_share" DOUBLE PRECISION NOT NULL,
    "asin_cart_adds" INTEGER NOT NULL,
    "asin_cart_add_share" DOUBLE PRECISION NOT NULL,
    "asin_purchases" INTEGER NOT NULL,
    "asin_purchase_share" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "search_query_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "search_query_metrics_seller_id_marketplace_id_report_period_idx" ON "search_query_metrics"("seller_id", "marketplace_id", "report_period", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "search_query_metrics_seller_id_marketplace_id_report_period_key" ON "search_query_metrics"("seller_id", "marketplace_id", "report_period", "period_start", "asin", "query_text");
