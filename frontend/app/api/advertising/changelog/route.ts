import { type NextRequest, NextResponse } from "next/server";
import { adsBackendPath, adsCountryFrom, adsSnapshotKey } from "@/lib/adsCountry";
import { isSupabaseConfigured, readSnapshot } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

/** Change Log of advertising decisions of one country's profile (spec advertising §9), read live. */
export async function GET(request: NextRequest) {
  const country = adsCountryFrom(request.url);
  if (isSupabaseConfigured()) {
    try {
      const harvest = (await readSnapshot(adsSnapshotKey("advertising:keywords:harvest", country)))?.data as { profileId?: string } | undefined;
      if (harvest?.profileId) {
        const entries = (await readSnapshot(`ads:changelog:${harvest.profileId}`))?.data ?? [];
        return NextResponse.json({ profileId: harvest.profileId, entries });
      }
    } catch {
      // Fall through to the local backend.
    }
  }
  try {
    const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
    const res = await fetch(`${backendUrl}${adsBackendPath("/api/advertising/changelog", country)}`, { cache: "no-store" });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ entries: [] });
  }
}
