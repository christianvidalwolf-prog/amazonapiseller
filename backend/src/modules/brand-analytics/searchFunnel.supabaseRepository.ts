import type { SearchQueryMetricsRepository, StoredSearchQueryMetrics } from "./searchFunnel.repository";
import type { ReportPeriod, SearchQueryMetrics } from "./searchFunnel.types";

interface StoredPeriod {
  periodStart: string;
  periodEnd: string;
  /** Every ASIN requested for the period so far, with or without rows. */
  asins?: string[];
  metrics: SearchQueryMetrics[];
}

interface SnapshotRow<T> {
  key: string;
  data: T;
  updated_at: string;
}

const metricsKey = (marketplaceId: string, period: ReportPeriod, periodStart: string) =>
  `sqp:metrics:${marketplaceId}:${period}:${periodStart}`;
const unavailableKey = (marketplaceId: string, period: ReportPeriod, periodStart: string) =>
  `sqp:unavailable:${marketplaceId}:${period}:${periodStart}`;

/**
 * Keeps the raw report rows in the Supabase `snapshots` table, one row per
 * marketplace, report period and period start. It is the one store the nightly
 * workflow, a local backend and a hosted one all reach, so a closed week or
 * month is downloaded from Amazon once and reused by every later sync.
 */
export function createSupabaseSearchQueryMetricsRepository(supabaseUrl: string, serviceRoleKey: string): SearchQueryMetricsRepository {
  const base = `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/snapshots`;
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };

  async function select<T>(query: string): Promise<Array<SnapshotRow<T>>> {
    const res = await fetch(`${base}?${query}`, { headers });
    if (!res.ok) throw new Error(`Supabase respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as Array<SnapshotRow<T>>;
  }

  async function upsert(key: string, data: unknown): Promise<void> {
    const res = await fetch(`${base}?on_conflict=key`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`Supabase upsert de '${key}' falló (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  const one = async <T>(key: string) => (await select<T>(`key=eq.${encodeURIComponent(key)}&select=key,data,updated_at`))[0] ?? null;

  return {
    async replace(marketplaceId, period, range, asins, metrics) {
      const key = metricsKey(marketplaceId, period, range.periodStart);
      const existing = (await one<StoredPeriod>(key))?.data;
      // Only the refreshed ASINs are replaced, so a single-ASIN or single-batch sync keeps the rest of the period.
      const refreshed = new Set(asins);
      const kept = (existing?.metrics ?? []).filter((m) => !refreshed.has(m.asin));
      const covered = new Set([...(existing?.asins ?? existing?.metrics.map((m) => m.asin) ?? []), ...asins]);
      await upsert(key, { ...range, asins: [...covered], metrics: [...kept, ...metrics] } satisfies StoredPeriod);
    },

    async latest(marketplaceId, period, periods = 1) {
      // Keys end in the ISO period start, so ordering by key is ordering by date.
      const pattern = encodeURIComponent(metricsKey(marketplaceId, period, "*"));
      const newest = await select<never>(`key=like.${pattern}&select=key&order=key.desc&limit=${periods}`);
      if (!newest.length) return null;

      const rows = await Promise.all(newest.map((row) => one<StoredPeriod>(row.key)));
      const stored: StoredSearchQueryMetrics & { covered: Record<string, string[]> } = { updatedAt: "", metrics: [], covered: {} };
      for (const row of rows) {
        if (!row) continue;
        if (row.updated_at > stored.updatedAt) stored.updatedAt = row.updated_at;
        stored.metrics.push(...row.data.metrics);
        if (row.data.asins) stored.covered[row.data.periodStart] = row.data.asins;
      }
      return stored;
    },

    async unavailableSince(marketplaceId, period, periodStart) {
      const row = await one<{ checkedAt: string }>(unavailableKey(marketplaceId, period, periodStart));
      return row?.data.checkedAt ?? null;
    },

    async markUnavailable(marketplaceId, period, periodStart) {
      await upsert(unavailableKey(marketplaceId, period, periodStart), { checkedAt: new Date().toISOString() });
    },
  };
}
