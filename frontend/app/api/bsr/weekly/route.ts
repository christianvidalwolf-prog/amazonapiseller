import { type NextRequest, NextResponse } from "next/server";
import { bsrMarketplaceParams } from "@/lib/bsrMarketplaces";
import { snapshotResponse } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const marketplace = bsrMarketplaceParams(req.nextUrl.searchParams);
  if (!marketplace) return NextResponse.json({ error: "invalid_marketplace" }, { status: 400 });
  const key = marketplace.keyPrefix ? `bsr:weekly:${marketplace.code}` : "bsr:weekly";
  return snapshotResponse(key, `/api/bsr/weekly${marketplace.query ? `?${marketplace.query}` : ""}`);
}
