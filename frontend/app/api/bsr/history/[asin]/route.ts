import { snapshotResponse } from "@/lib/snapshots";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { asin: string } }
) {
  const days = Number(req.nextUrl.searchParams.get("days") || "60");
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    return NextResponse.json({ error: "invalid_days", message: "El periodo debe estar entre 1 y 90 días." }, { status: 400 });
  }
  const asin = params.asin;

  const response = await snapshotResponse(
    `bsr:history:${asin}`,
    `/api/bsr/history/${encodeURIComponent(asin)}?days=${days}`
  );
  if (!response.ok) return response;

  const data = await response.json();
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days + 1);
  const firstDate = cutoff.toISOString().slice(0, 10);
  const history = data.history.filter((point: { date: string }) => point.date >= firstDate);
  const ranks = (field: "rootRank" | "detailRank"): number[] =>
    history.map((point: Record<string, unknown>) => point[field]).filter((rank: unknown): rank is number => typeof rank === "number" && Number.isFinite(rank));
  const roots = ranks("rootRank");
  const details = ranks("detailRank");
  return NextResponse.json({
    ...data,
    history,
    stats: {
      ...data.stats,
      bestRootRank: roots.length ? Math.min(...roots) : null,
      worstRootRank: roots.length ? Math.max(...roots) : null,
      bestDetailRank: details.length ? Math.min(...details) : null,
      worstDetailRank: details.length ? Math.max(...details) : null,
    },
  }, { headers: response.headers });
}
