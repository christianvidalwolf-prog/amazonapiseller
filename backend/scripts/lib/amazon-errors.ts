/** True when Amazon says the ASIN is not present in the selected marketplace. */
export function isMarketplaceMissingAsinError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /requested item[\s\S]*(?:not found|does not exist)|not found in marketplace/i.test(message);
}
