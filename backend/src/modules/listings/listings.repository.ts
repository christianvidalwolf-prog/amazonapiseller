import type { PrismaClient } from "@prisma/client";
import type { ListingSubmissionRepository } from "./listings.service";

export function createPrismaListingSubmissionRepository(prisma: PrismaClient): ListingSubmissionRepository {
  return {
    async saveSubmission(record) {
      try {
        await prisma.listingSubmission.create({
          data: {
            sku: record.sku,
            productType: record.productType,
            submissionId: record.submissionId,
            marketplaceId: record.marketplaceId,
            status: record.status,
            issues: (record.issues ?? []) as any,
          },
        });
      } catch (err) {
        console.warn("No se pudo persistir la sumisión en Postgres (Base de datos local inalcanzable):", (err as Error).message);
      }
    },
    async getLatestSubmission(sku, marketplaceId) {
      return prisma.listingSubmission.findFirst({
        where: { sku, ...(marketplaceId ? { marketplaceId } : {}) },
        orderBy: { createdAt: "desc" },
      });
    },
  };
}
