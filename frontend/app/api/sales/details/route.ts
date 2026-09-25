import { type NextRequest, NextResponse } from "next/server";
import type { PeriodSalesDetailResult } from "@/components/sales/PeriodSalesDetail";
import { filterSalesDetails } from "@/lib/sales-details";
import { readSnapshot } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

function normalizeDate(value: string, endOfDay: boolean): string | null {
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
  const dateOnly = value.slice(0, 10);
  const day = new Date(`${dateOnly}T00:00:00.000Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== dateOnly) return null;
  const date = new Date(value.length === 10 ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export async function GET(req: NextRequest) {
  const rawStart = req.nextUrl.searchParams.get("start") ?? "";
  const start = normalizeDate(rawStart, false);
  const end = normalizeDate(req.nextUrl.searchParams.get("end") ?? rawStart, true);
  const channel = req.nextUrl.searchParams.get("channel") || "ALL";
  if (!start || !end || start > end || Date.parse(end) - Date.parse(start) > 366 * 86400000) {
    return NextResponse.json({ error: "invalid_period", message: "Indica un periodo válido de hasta un año con fechas de inicio y fin." }, { status: 400 });
  }

  let snapshotError: string;
  try {
    const months: string[] = [];
    const cursor = new Date(`${start.slice(0, 7)}-01T00:00:00.000Z`);
    // A week may extend into next month; future months cannot have orders yet.
    const now = new Date().toISOString();
    const lastMonth = (end < now ? end : now).slice(0, 7);
    while (cursor.toISOString().slice(0, 7) <= lastMonth) {
      months.push(cursor.toISOString().slice(0, 7));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    const rows = await Promise.all(months.map(async (month) => {
      const key = `sales:details:${month}`;
      const row = await readSnapshot(key);
      if (!row) throw new Error(`Faltan los pedidos de ${month}. Ejecuta el workflow 'Sync Amazon data → Supabase' para sincronizarlos.`);
      const data = row.data as PeriodSalesDetailResult;
      if (!data || !Array.isArray(data.orders)) throw new Error(`El registro '${key}' no contiene un detalle de pedidos válido.`);
      return { ...row, data };
    }));
    const result = filterSalesDetails(rows.flatMap((row) => row.data.orders), start, end, channel);
    const updatedAt = rows.map((row) => row.updated_at).sort()[0];
    return NextResponse.json(result, { headers: updatedAt ? { "x-snapshot-updated-at": updatedAt } : undefined });
  } catch (err) {
    snapshotError = err instanceof Error ? err.message : "No se pudieron leer los pedidos sincronizados.";
  }

  const backendUrl = process.env.NEXT_PUBLIC_API_URL || (process.env.NODE_ENV !== "production" ? "http://localhost:4000" : "");
  if (backendUrl) {
    try {
      const params = new URLSearchParams({ start, end, channel });
      const res = await fetch(`${backendUrl}/api/sales/details?${params}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (res.ok) return NextResponse.json(await res.json());
    } catch {
      // Retain the actionable snapshot error when a local backend is unavailable.
    }
  }
  return NextResponse.json({ error: "sales_details_not_ready", message: snapshotError }, { status: 503 });
}
