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

/**
 * Registros archivados (todos, o solo los de ciertos estados). Supabase manda; la copia local es el
 * respaldo. Se pagina por clave en bloques pequeños, porque los registros llevan la ficha completa y
 * una consulta con offset sobre miles de filas grandes supera el statement timeout de Supabase.
 */
export async function loadArchive(opts: { statuses?: ArchiveRecord["status"][] } = {}): Promise<Map<string, ArchiveRecord>> {
  const wanted = opts.statuses?.length ? new Set(opts.statuses) : null;
  if (!usesSupabase) {
    const local = Object.entries(readLocal()).filter(([, r]) => !wanted || wanted.has(r.status));
    return new Map(local);
  }
  const out = new Map<string, ArchiveRecord>();
  const page = 250;
  const statusFilter = wanted ? `&data->>status=in.(${[...wanted].join(",")})` : "";
  let last = ARCHIVE_PREFIX;
  for (;;) {
    const after = encodeURIComponent(`(key.gt."${last.replaceAll('"', '\\"')}")`);
    const url = `${supabaseUrl}/rest/v1/snapshots?key=like.${encodeURIComponent(`${ARCHIVE_PREFIX}*`)}&and=${after}${statusFilter}&select=key,data&order=key&limit=${page}`;
    let rows: Array<{ key: string; data: ArchiveRecord }> | null = null;
    for (let attempt = 0; attempt < 5 && !rows; attempt++) {
      const res = await fetch(url, { headers: headers() });
      if (res.ok) rows = (await res.json()) as Array<{ key: string; data: ArchiveRecord }>;
      else if (attempt === 4 || res.status < 500) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
      else await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
    for (const r of rows!) out.set(r.data.sku, r.data);
    if (rows!.length < page) break;
    last = rows![rows!.length - 1].key;
  }
  // Registros guardados antes de configurar Supabase (o si falló una subida): se suben ahora.
  // Solo con la lista completa; con filtro faltarían los de otros estados y se resubirían todos.
  if (!wanted) {
    const localOnly = Object.values(readLocal()).filter((r) => !out.has(r.sku));
    if (localOnly.length) {
      await saveRecords(localOnly);
      for (const r of localOnly) out.set(r.sku, r);
    }
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
  // Bloques pequeños: con la ficha completa, 200 registros por petición superan el statement timeout.
  for (let i = 0; i < records.length; i += 40) {
    const body = records.slice(i, i + 40).map((data) => ({ key: `${ARCHIVE_PREFIX}${data.sku}`, data, updated_at: now }));
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${supabaseUrl}/rest/v1/snapshots?on_conflict=key`, {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(body),
      });
      if (res.ok) break;
      if (attempt === 4 || res.status < 500) throw new Error(`Supabase upsert archivo ${res.status}: ${await res.text()}`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
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
