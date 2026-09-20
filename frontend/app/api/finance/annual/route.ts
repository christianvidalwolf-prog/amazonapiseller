import { NextRequest, NextResponse } from "next/server";
import { snapshotResponse } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const backendUrl = process.env.NEXT_PUBLIC_API_URL;
  const searchParams = req.nextUrl.searchParams.toString();

  if (backendUrl) {
    try {
      const res = await fetch(`${backendUrl}/api/finance/annual?${searchParams}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(60000),
      });
      if (res.ok) {
        return NextResponse.json(await res.json());
      }
    } catch {}
  }

  return snapshotResponse("finance:annual");
}
