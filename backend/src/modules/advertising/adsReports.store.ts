import fs from "node:fs/promises";
import path from "node:path";
import type { AdsReportKind } from "../../ads/reportTypes";

/** Latest downloaded report of one kind for one profile. */
export interface StoredAdsReport<T = unknown> {
  profileId: string;
  kind: AdsReportKind;
  startDate: string;
  endDate: string;
  generatedAt: string;
  rows: T[];
}

export interface AdsReportStore {
  load<T>(profileId: string, kind: AdsReportKind): Promise<StoredAdsReport<T> | null>;
  save<T>(report: StoredAdsReport<T>): Promise<void>;
  /** Any other snapshot by key (e.g. margins:products). */
  readSnapshot<T>(key: string): Promise<T | null>;
  writeSnapshot(key: string, data: unknown): Promise<void>;
}

export const adsReportKey = (profileId: string, kind: AdsReportKind) => `ads:report:${kind}:${profileId}`;
/** Unit margins of the SKUs advertised by a profile (built by ads:sync-reports). */
export const adsMarginsKey = (profileId: string) => `ads:margins:${profileId}`;
/** Stock / Buy Box / returns context of the advertised SKUs (spec §9). */
export const adsContextKey = (profileId: string) => `ads:context:${profileId}`;
/** Profit-first campaign plan of a profile (spec §10). */
export const adsPlanKey = (profileId: string) => `ads:plan:${profileId}`;

/** Supabase `snapshots` table: the store the nightly workflow, local and hosted backends all reach. */
export function createSupabaseAdsReportStore(supabaseUrl: string, serviceRoleKey: string): AdsReportStore {
  const base = `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/snapshots`;
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };

  async function read<T>(key: string): Promise<T | null> {
    const res = await fetch(`${base}?key=eq.${encodeURIComponent(key)}&select=data`, { headers, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Supabase respondió ${res.status} leyendo '${key}': ${(await res.text()).slice(0, 200)}`);
    const rows = (await res.json()) as Array<{ data: T }>;
    return rows[0]?.data ?? null;
  }

  async function write(key: string, data: unknown): Promise<void> {
    const res = await fetch(`${base}?on_conflict=key`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Supabase upsert de '${key}' falló (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  return {
    load: (profileId, kind) => read(adsReportKey(profileId, kind)),
    readSnapshot: read,
    writeSnapshot: write,
    save: (report) => write(adsReportKey(report.profileId, report.kind), report),
  };
}

/** Local fallback without Supabase: one JSON file per key under backend/data/ads-reports. */
export function createFileAdsReportStore(dir: string): AdsReportStore {
  const file = (key: string) => path.join(dir, `${key.replace(/[^a-zA-Z0-9_-]+/g, "_")}.json`);
  async function read<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(file(key), "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
  async function write(key: string, data: unknown): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file(key), JSON.stringify(data));
  }
  return {
    load: (profileId, kind) => read(adsReportKey(profileId, kind)),
    readSnapshot: read,
    writeSnapshot: write,
    save: (report) => write(adsReportKey(report.profileId, report.kind), report),
  };
}
