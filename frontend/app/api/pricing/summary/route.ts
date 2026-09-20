import { snapshotResponse } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

export function GET() {
  return snapshotResponse("pricing:summary");
}
