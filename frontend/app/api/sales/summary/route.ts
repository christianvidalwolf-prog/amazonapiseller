import type { NextRequest } from "next/server";
import { snapshotResponse } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

const PERIODS = new Set(["year", "this_month", "last_30d"]);
const MONTH_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("period") ?? "year";
  if (MONTH_PERIOD.test(raw)) return snapshotResponse(`sales:month-${raw}`);
  const period = PERIODS.has(raw) ? raw : "year";
  return snapshotResponse(`sales:${period}`);
}
