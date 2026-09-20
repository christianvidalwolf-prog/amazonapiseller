import { NextResponse } from "next/server";

interface SnapshotRow {
  data: unknown;
  updated_at: string;
}

/** Reads one precomputed dashboard payload from Supabase (server-side, service-role key). */
export async function readSnapshot(key: string): Promise<SnapshotRow | null> {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Supabase no configurado (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");

  const res = await fetch(`${url}/rest/v1/snapshots?key=eq.${encodeURIComponent(key)}&select=data,updated_at`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Supabase respondió ${res.status}`);
  const rows = (await res.json()) as SnapshotRow[];
  return rows[0] ?? null;
}

export async function snapshotResponse(key: string): Promise<NextResponse> {
  try {
    const row = await readSnapshot(key);
    if (!row) {
      return NextResponse.json(
        { error: "snapshot_not_ready", message: "Aún no hay datos sincronizados. Ejecuta el workflow de sincronización." },
        { status: 503 }
      );
    }
    return NextResponse.json(row.data, { headers: { "x-snapshot-updated-at": row.updated_at } });
  } catch (err) {
    return NextResponse.json(
      { error: "snapshot_error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export function notAvailableInProduction(what: string): NextResponse {
  return NextResponse.json(
    { error: "not_available", message: `${what} solo está disponible ejecutando el backend en local.` },
    { status: 501 }
  );
}
