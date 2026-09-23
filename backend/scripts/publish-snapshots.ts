/**
 * Builds every dashboard payload by calling the backend's own Express routes
 * in-process, then upserts each one into the Supabase `snapshots` table.
 * The deployed (Vercel) frontend only ever reads those rows, never Amazon.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (+ the normal backend env).
 * Optional: ONLY=sales,inventory  → publish just keys starting with those prefixes.
 *           DRY_RUN=1             → build payloads but don't write to Supabase.
 */
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app";

let rawUrl = (process.env.SUPABASE_URL ?? "").trim();
if (rawUrl && !rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) {
  rawUrl = `https://${rawUrl}`;
}
const SUPABASE_URL = rawUrl.replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const DRY_RUN = process.env.DRY_RUN === "1";
const ONLY = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function isoStartOfYear(): string {
  return new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)).toISOString();
}
function isoStartOfMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

const enc = encodeURIComponent;
const TARGETS: Array<[key: string, path: string]> = [
  ["inventory:snapshot", "/api/inventory/snapshot"],
  ["listings:list", "/api/listings"],
  ["sales:year", `/api/sales/summary?start=${enc(isoStartOfYear())}`],
  ["sales:this_month", `/api/sales/summary?start=${enc(isoStartOfMonth())}`],
  ["sales:last_30d", `/api/sales/summary?start=${enc(isoDaysAgo(30))}`],
  ["finance:summary", "/api/finance/summary?refresh=true"],
  ["account-health:summary", "/api/account-health/summary?force=true"],
  ["pricing:summary", "/api/pricing/summary?limit=40&force=true"],
  ["advertising:summary", "/api/advertising/summary"],
  ["advertising:campaigns", "/api/advertising/campaigns"],
];

async function upsert(key: string, data: unknown): Promise<void> {
  const fullUrl = `${SUPABASE_URL}/rest/v1/snapshots?on_conflict=key`;
  const res = await fetch(fullUrl, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY!,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const errorBody = await res.text();
    if (res.status === 405) {
      throw new Error(
        `Supabase upsert failed (405 Method Not Allowed) en ${fullUrl}. ` +
        `Causa común: la tabla 'snapshots' no existe en el esquema público de Supabase o la URL de Supabase es incorrecta. ` +
        `Verifica haber ejecutado supabase/schema.sql en el SQL Editor de Supabase. Respuesta: ${errorBody}`
      );
    }
    throw new Error(`Supabase upsert failed (${res.status}): ${errorBody}`);
  }
}

async function main(): Promise<void> {
  if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_KEY)) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or set DRY_RUN=1)");
  }

  const server = buildApp().listen(0);
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const targets = ONLY.length ? TARGETS.filter(([key]) => ONLY.some((p) => key.startsWith(p))) : TARGETS;
  let published = 0;

  for (const [key, path] of targets) {
    try {
      const res = await fetch(base + path);
      if (!res.ok) throw new Error(`endpoint returned ${res.status}`);
      const data = await res.json();
      const bytes = JSON.stringify(data).length;
      if (!DRY_RUN) await upsert(key, data);
      published += 1;
      console.log(`ok   ${key} (${(bytes / 1024).toFixed(0)} KB)${DRY_RUN ? " [dry-run]" : ""}`);
    } catch (err) {
      // A failed target keeps its previous snapshot in Supabase instead of blanking the dashboard.
      console.error(`FAIL ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  server.close();
  console.log(`${published}/${targets.length} snapshots published`);
  process.exit(published === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
