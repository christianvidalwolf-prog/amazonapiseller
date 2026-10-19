import type { NextRequest } from "next/server";
import { adsBackendPath, adsCountryFrom, adsSnapshotKey } from "@/lib/adsCountry";
import { snapshotResponse } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const country = adsCountryFrom(request.url);
  return snapshotResponse(adsSnapshotKey("advertising:summary", country), adsBackendPath("/api/advertising/summary", country));
}
