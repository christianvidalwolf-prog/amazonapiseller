import { type NextRequest, NextResponse } from "next/server";
import { FUNNEL_STATUSES, filterFunnel, type FunnelStatus, type SearchFunnelResponse } from "@/lib/searchFunnel";
import { readSnapshot } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

/** Express backend when there is one (local dev, or a hosted one); Vercel alone has none and uses the snapshot. */
const backendUrl = () => process.env.BACKEND_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export async function GET(req: NextRequest) {
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
  const filters = { asin: asin || undefined, status: (status || undefined) as FunnelStatus | undefined };

  // The backend is asked for the whole period so "it has nothing synced" can be told apart from
  // "the filters match nothing": a freshly deployed backend answers 200 with no rows, and that
  // must not hide the snapshot the nightly workflow already published.
  let fromBackend: SearchFunnelResponse | null = null;
  try {
    const res = await fetch(`${backendUrl()}/api/brand-analytics/search-funnel?period=${period}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(60000),
    });
    if (res.ok) fromBackend = (await res.json()) as SearchFunnelResponse;
  } catch {
    // Backend not running: fall through to the published snapshot.
  }
  if (fromBackend?.rows?.length) return NextResponse.json(filterFunnel(fromBackend, filters));

  const key = `brand-analytics:search-funnel:${period}`;
  let snapshotError: string | null = null;
  try {
    const row = await readSnapshot(key);
    if (row?.data) {
      return NextResponse.json(filterFunnel(row.data as SearchFunnelResponse, filters), {
        headers: { "x-snapshot-updated-at": row.updated_at },
      });
    }
  } catch (err) {
    snapshotError = err instanceof Error ? err.message : String(err);
  }

  // Nothing published either: an empty backend answer still lets the page offer "Sincronizar".
  if (fromBackend) return NextResponse.json(fromBackend);
  return NextResponse.json(
    {
      error: "snapshot_not_ready",
      key,
      message:
        snapshotError ||
        `La tabla snapshots en Supabase no tiene el registro '${key}'. Ejecuta el workflow 'Sync Amazon data → Supabase' en GitHub Actions.`,
    },
    { status: 503 }
  );
}
