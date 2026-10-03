import { type NextRequest, NextResponse } from "next/server";
import { FUNNEL_STATUSES, filterFunnel, type FunnelStatus, type SearchFunnelResponse } from "@/lib/searchFunnel";
import { readSnapshot } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const backendUrl = process.env.BACKEND_API_URL || "http://localhost:4000";
  const params = req.nextUrl.searchParams;
  const period = (params.get("period") || "WEEK").toUpperCase();
  const asin = (params.get("asin") || "").toUpperCase();
  const status = (params.get("status") || "").toUpperCase();

  if (period !== "WEEK" && period !== "MONTH") {
    return NextResponse.json({ error: "invalid_query", message: "period debe ser WEEK o MONTH" }, { status: 400 });
  }
  if (status && !FUNNEL_STATUSES.includes(status as FunnelStatus)) {
    return NextResponse.json({ error: "invalid_query", message: "status no válido" }, { status: 400 });
  }

  try {
    const query = new URLSearchParams({ period, ...(asin ? { asin } : {}), ...(status ? { status } : {}) });
    const res = await fetch(`${backendUrl}/api/brand-analytics/search-funnel?${query}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(60000),
    });
    if (res.ok) return NextResponse.json(await res.json());
  } catch {
    // Backend not running (Vercel): fall through to the published snapshot.
  }

  const key = `brand-analytics:search-funnel:${period}`;
  try {
    const row = await readSnapshot(key);
    if (row?.data) {
      const payload = filterFunnel(row.data as SearchFunnelResponse, {
        asin: asin || undefined,
        status: (status || undefined) as FunnelStatus | undefined,
      });
      return NextResponse.json(payload, { headers: { "x-snapshot-updated-at": row.updated_at } });
    }
  } catch (err) {
    return NextResponse.json(
      { error: "snapshot_not_ready", key, message: err instanceof Error ? err.message : String(err) },
      { status: 503 }
    );
  }
  return NextResponse.json(
    {
      error: "snapshot_not_ready",
      key,
      message: `La tabla snapshots en Supabase no tiene el registro '${key}'. Ejecuta el workflow 'Sync Amazon data → Supabase' en GitHub Actions.`,
    },
    { status: 503 }
  );
}
