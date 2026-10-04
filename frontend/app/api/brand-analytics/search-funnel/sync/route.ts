import { type NextRequest, NextResponse } from "next/server";
import { notAvailableInProduction } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

const backendSyncUrl = () =>
  `${process.env.BACKEND_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"}/api/brand-analytics/search-funnel/sync`;

/** Requesting the report from Amazon needs the Express backend; on Vercel the nightly workflow refreshes the snapshot. */
async function proxy(init: RequestInit): Promise<NextResponse> {
  try {
    const res = await fetch(backendSyncUrl(), { ...init, cache: "no-store", signal: AbortSignal.timeout(15000) });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return notAvailableInProduction("Sincronizar el informe de Brand Analytics");
  }
}

export async function GET() {
  return proxy({ method: "GET" });
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  return proxy({ method: "POST", headers: { "Content-Type": "application/json" }, body: body || "{}" });
}
