import { type NextRequest, NextResponse } from "next/server";
import { snapshotResponse } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const backendUrl = process.env.BACKEND_API_URL || "http://localhost:4000";
  const searchParams = req.nextUrl.searchParams;
  const country = (searchParams.get("country") || "ALL").toUpperCase();

  if (backendUrl) {
    try {
      const res = await fetch(`${backendUrl}/api/finance/reimbursements?country=${encodeURIComponent(country)}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(60000),
      });
      if (res.ok) {
        return NextResponse.json(await res.json());
      }
    } catch {}
  }

  const snapshotKey = country === "ALL" ? "finance:reimbursements" : `finance:reimbursements:${country}`;
  return snapshotResponse(snapshotKey, "finance:reimbursements");
}
