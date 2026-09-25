import { bsrMarketplaceParams } from "@/lib/bsrMarketplaces";
import { notAvailableInProduction } from "@/lib/snapshots";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { asin: string } }
) {
  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
  const asin = params.asin;
  const marketplace = bsrMarketplaceParams(req.nextUrl.searchParams);
  if (!marketplace) {
    return NextResponse.json({ error: "invalid_marketplace", message: "Marketplace no soportado." }, { status: 400 });
  }

  try {
    const res = await fetch(`${backendUrl}/api/bsr/refresh/${encodeURIComponent(asin)}${marketplace.query ? `?${marketplace.query}` : ""}`, {
      method: "POST",
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({ error: `Backend error ${res.status}` }, { status: res.status });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return notAvailableInProduction("Actualizar BSR en vivo");
  }
}
