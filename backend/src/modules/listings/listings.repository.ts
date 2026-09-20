import type { PrismaClient } from "@prisma/client";
import type { ListingSubmissionRepository } from "./listings.service";

export function createPrismaListingSubmissionRepository(prisma: PrismaClient): ListingSubmissionRepository {
  return {
    async saveSubmission(record) {
      await prisma.listingSubmission.create({
        data: {
          sku: record.sku,
          productType: record.productType,
          submissionId: record.submissionId,
          status: record.status,
          issues: (record.issues ?? []) as any,
        },
      });
    },
  };
}
