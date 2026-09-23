import { NextResponse } from "next/server";

interface SnapshotRow {
  data: unknown;
  updated_at: string;
}

/** Reads one precomputed dashboard payload from Supabase (server-side, service-role key). */
export async function readSnapshot(key: string, fallbackKey?: string): Promise<SnapshotRow | null> {
  let rawUrl = (process.env.SUPABASE_URL ?? "").trim();
  if (rawUrl && !rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) {
    rawUrl = `https://${rawUrl}`;
  }
  const url = rawUrl.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) throw new Error("Supabase no configurado (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");

  const res = await fetch(`${url}/rest/v1/snapshots?key=eq.${encodeURIComponent(key)}&select=data,updated_at`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`Supabase respondió ${res.status}: ${errorText}`);
  }
  const rows = (await res.json()) as SnapshotRow[];
  if (rows[0]) return rows[0];

  if (fallbackKey && fallbackKey !== key) {
    const fallbackRes = await fetch(`${url}/rest/v1/snapshots?key=eq.${encodeURIComponent(fallbackKey)}&select=data,updated_at`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      cache: "no-store",
    });
    if (fallbackRes.ok) {
      const fallbackRows = (await fallbackRes.json()) as SnapshotRow[];
      return fallbackRows[0] ?? null;
    }
  }

  return null;
}

export async function snapshotResponse(key: string, fallbackKeyOrBackendPath?: string): Promise<NextResponse> {
  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
  let supabaseError: string | null = null;
  const isFallbackSnapshotKey = fallbackKeyOrBackendPath && !fallbackKeyOrBackendPath.startsWith("/");
  const fallbackKey = isFallbackSnapshotKey ? fallbackKeyOrBackendPath : undefined;
  const backendFallbackPath = !isFallbackSnapshotKey ? fallbackKeyOrBackendPath : undefined;

  // First try reading from Supabase if configured
  try {
    const row = await readSnapshot(key, fallbackKey);
    if (row && row.data) {
      return NextResponse.json(row.data, { headers: { "x-snapshot-updated-at": row.updated_at } });
    }
    if (!row) {
      supabaseError = `La tabla snapshots en Supabase no tiene el registro '${key}'. Ejecuta el workflow 'Sync Amazon data → Supabase' en GitHub Actions.`;
    }
  } catch (err) {
    supabaseError = err instanceof Error ? err.message : String(err);
  }

  // If running locally or NEXT_PUBLIC_API_URL is configured, proxy to backend
  let fallbackPath = backendFallbackPath;
  if (!fallbackPath) {
    if (key.startsWith("sales:")) {
      const p = key.replace("sales:", "");
      fallbackPath = `/api/sales/summary?period=${encodeURIComponent(p)}`;
    } else if (key === "inventory:snapshot") {
      fallbackPath = "/api/inventory/snapshot";
    } else if (key === "listings:list") {
      fallbackPath = "/api/listings";
    } else if (key.startsWith("pricing:")) {
      fallbackPath = "/api/pricing/summary";
    } else if (key.startsWith("account-health:negatives")) {
      const parts = key.split(":");
      const mid = parts[2] || "EU";
      fallbackPath = `/api/account-health/negatives?marketplaceId=${encodeURIComponent(mid)}`;
    } else if (key.startsWith("account-health:summary")) {
      const parts = key.split(":");
      const mid = parts[2] || "EU";
      fallbackPath = `/api/account-health/summary?marketplaceId=${encodeURIComponent(mid)}`;
    } else if (key.startsWith("advertising:")) {
      fallbackPath = "/api/advertising/summary";
    } else if (key === "bsr:catalog") {
      fallbackPath = "/api/bsr/catalog";
    } else if (key.startsWith("bsr:history:")) {
      const asin = key.replace("bsr:history:", "");
      fallbackPath = `/api/bsr/history/${encodeURIComponent(asin)}`;
    }
  }

  if (fallbackPath) {
    try {
      const backendRes = await fetch(`${backendUrl}${fallbackPath}`, { cache: "no-store" });
      if (backendRes.ok) {
        const data = await backendRes.json();
        return NextResponse.json(data);
      }
    } catch {
      // Backend not running
    }
  }

  return NextResponse.json(
    {
      error: "snapshot_not_ready",
      key,
      message: supabaseError || "No se encontraron datos en Supabase ni en el backend.",
      hint: "En Vercel se requieren las variables de entorno SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY y tener la tabla snapshots poblada.",
    },
    { status: 503 }
  );
}

export function notAvailableInProduction(what: string): NextResponse {
  return NextResponse.json(
    { error: "not_available", message: `${what} solo está disponible ejecutando el backend en local.` },
    { status: 501 }
  );
}

