import { snapshotResponse } from "@/lib/snapshots";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const backendUrl = process.env.BACKEND_API_URL || "http://localhost:4000";
  const query = request.nextUrl.searchParams.toString();
  try {
    const response = await fetch(`${backendUrl}/api/inventory/snapshot${query ? `?${query}` : ""}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(120000),
    });
    if (response.ok) return NextResponse.json(await response.json());
  } catch {
    // Use the last published snapshot when the backend is unavailable.
  }
  return snapshotResponse("inventory:snapshot");
}
