import { bsrMarketplaceParams } from "@/lib/bsrMarketplaces";
import { snapshotResponse } from "@/lib/snapshots";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const marketplace = bsrMarketplaceParams(req.nextUrl.searchParams);
  if (!marketplace) return NextResponse.json({ error: "invalid_marketplace", message: "Marketplace no soportado." }, { status: 400 });
  const key = marketplace.keyPrefix ? `bsr:catalog:${marketplace.code}` : "bsr:catalog";
  return snapshotResponse(key, `/api/bsr/catalog${marketplace.query ? `?${marketplace.query}` : ""}`);
}
