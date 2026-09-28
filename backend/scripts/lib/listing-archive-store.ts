/**
 * Archivo de listings borrados (ver listing-cleanup.ts). Cada SKU es una fila de la tabla
 * `snapshots` de Supabase con clave `listings:archive:<sku>`; siempre se guarda además una
 * copia local en backend/data/listing-archive.json. Sin SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
 * solo se usa la copia local.
 */
import fs from "node:fs";
import path from "node:path";
import type { ArchiveRecord } from "./listing-cleanup";

export const ARCHIVE_PREFIX = "listings:archive:";
const LOCAL_FILE = path.resolve(process.cwd(), "data", "listing-archive.json");

const supabaseUrl = (() => {
  const raw = (process.env.SUPABASE_URL ?? "").trim();
  return (raw && !/^https?:\/\//.test(raw) ? `https://${raw}` : raw).replace(/\/+$/, "");
})();
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
export const usesSupabase = Boolean(supabaseUrl && supabaseKey);
const headers = () => ({ apikey: supabaseKey!, Authorization: `Bearer ${supabaseKey}` });

function readLocal(): Record<string, ArchiveRecord> {
  return fs.existsSync(LOCAL_FILE) ? JSON.parse(fs.readFileSync(LOCAL_FILE, "utf-8")) : {};
}

function writeLocal(all: Record<string, ArchiveRecord>): void {
  fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
  const tmp = `${LOCAL_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all));
  fs.renameSync(tmp, LOCAL_FILE);
}

/** Todos los registros archivados. Supabase manda; la copia local es el respaldo. */
export async function loadArchive(): Promise<Map<string, ArchiveRecord>> {
  if (!usesSupabase) return new Map(Object.entries(readLocal()));
  const out = new Map<string, ArchiveRecord>();
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const url = `${supabaseUrl}/rest/v1/snapshots?key=like.${encodeURIComponent(`${ARCHIVE_PREFIX}*`)}&select=data&order=key&limit=${page}&offset=${offset}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as Array<{ data: ArchiveRecord }>;
    for (const r of rows) out.set(r.data.sku, r.data);
    if (rows.length < page) break;
  }
  // Registros guardados antes de configurar Supabase (o si falló una subida): se suben ahora.
  const localOnly = Object.values(readLocal()).filter((r) => !out.has(r.sku));
  if (localOnly.length) {
    await saveRecords(localOnly);
    for (const r of localOnly) out.set(r.sku, r);
  }
  return out;
}

/** Inserta o actualiza registros (por SKU) en Supabase y en la copia local. */
export async function saveRecords(records: ArchiveRecord[]): Promise<void> {
  if (!records.length) return;
  const local = readLocal();
  for (const r of records) local[r.sku] = r;
  writeLocal(local);
  if (!usesSupabase) return;
  const now = new Date().toISOString();
  for (let i = 0; i < records.length; i += 200) {
    const body = records.slice(i, i + 200).map((data) => ({ key: `${ARCHIVE_PREFIX}${data.sku}`, data, updated_at: now }));
    const res = await fetch(`${supabaseUrl}/rest/v1/snapshots?on_conflict=key`, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Supabase upsert archivo ${res.status}: ${await res.text()}`);
  }
}

/** Guarda un documento JSON en `snapshots` (informes de ejecución). Sin Supabase no hace nada. */
export async function writeSnapshot(key: string, data: unknown): Promise<void> {
  if (!usesSupabase) return;
  const res = await fetch(`${supabaseUrl}/rest/v1/snapshots?on_conflict=key`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase upsert ${key} ${res.status}: ${await res.text()}`);
}

export interface StockSnapshot { updatedAt: string; sourceFile: string; items: Array<Record<string, unknown>> }

/**
 * Última copia del STOCK AMZ que publica sync_daily_stock_amz.py (`stock:latest:meta` y
 * `stock:latest:NNNN`). null si no hay copia o si está incompleta.
 */
export async function loadStockSnapshot(): Promise<StockSnapshot | null> {
  if (!usesSupabase) throw new Error("La copia de stock está en Supabase: faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  const get = async (key: string) => {
    const res = await fetch(`${supabaseUrl}/rest/v1/snapshots?key=eq.${encodeURIComponent(key)}&select=data`, { headers: headers() });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    return ((await res.json()) as Array<{ data: any }>)[0]?.data ?? null;
  };
  const meta = await get("stock:latest:meta");
  if (!meta) return null;
  const items: Array<Record<string, unknown>> = [];
  for (let i = 0; i < Number(meta.chunkCount ?? 0); i++) {
    const chunk = await get(`stock:latest:${String(i).padStart(4, "0")}`);
    // Un bloque de otra fecha: la copia se estaba reescribiendo, mejor no usarla a medias.
    if (!chunk || chunk.updatedAt !== meta.updatedAt) return null;
    items.push(...(chunk.items ?? []));
  }
  return { updatedAt: meta.updatedAt, sourceFile: meta.sourceFile, items };
}
