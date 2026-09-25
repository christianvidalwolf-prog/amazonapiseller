import { type NextRequest, NextResponse } from "next/server";
import { snapshotResponse } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const backendUrl = process.env.BACKEND_API_URL || "http://localhost:4000";
  const search = req.nextUrl.searchParams.toString();
  try {
    const response = await fetch(`${backendUrl}/api/pricing/summary${search ? `?${search}` : ""}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(120000),
    });
    if (response.ok) return NextResponse.json(await response.json());
  } catch {
    // Fallback to the last snapshot when the backend is asleep or unavailable.
  }
  return snapshotResponse("pricing:summary");
}
