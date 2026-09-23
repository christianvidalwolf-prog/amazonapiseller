import { NextRequest, NextResponse } from "next/server";
import { snapshotResponse } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const asin = (req.nextUrl.searchParams.get("asin") || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    return NextResponse.json({ error: "invalid_asin", message: "Indica un ASIN válido." }, { status: 400 });
  }
  return snapshotResponse(`pricing:offers:${asin}`, `/api/pricing/offers?asin=${encodeURIComponent(asin)}`);
}
