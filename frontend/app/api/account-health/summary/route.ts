import { snapshotResponse } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mid = (searchParams.get("marketplaceId") || "EU").toUpperCase();
  return snapshotResponse(`account-health:summary:${mid}`, "account-health:summary");
}
