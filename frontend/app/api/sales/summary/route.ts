import { NextRequest } from "next/server";
import { snapshotResponse } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

const PERIODS = new Set(["year", "this_month", "last_30d"]);

export function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("period") ?? "year";
  const period = PERIODS.has(raw) ? raw : "year";
  return snapshotResponse(`sales:${period}`);
}
