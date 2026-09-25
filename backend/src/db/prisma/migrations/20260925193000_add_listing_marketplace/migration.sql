ALTER TABLE "ListingSubmission" ADD COLUMN "marketplaceId" TEXT;

CREATE INDEX "ListingSubmission_sku_marketplaceId_createdAt_idx"
ON "ListingSubmission"("sku", "marketplaceId", "createdAt");
