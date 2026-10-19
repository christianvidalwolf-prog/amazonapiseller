import type { AdsApiClient } from "../../ads/adsClient";
import { ADS_REPORT_KINDS, type AdsReportKind, buildReportRequest, reportWindow } from "../../ads/reportTypes";
import { sleep as defaultSleep } from "../../spapi/rateLimiter";
import type { AdsReportStore } from "./adsReports.store";

export interface AdsReportSyncResult {
  kind: AdsReportKind;
  status: "saved" | "failed" | "timeout";
  rows?: number;
  error?: string;
}

export interface AdsReportSyncOptions {
  now?: Date;
  kinds?: AdsReportKind[];
  /** Amazon usually builds these in a few minutes, sometimes much longer. */
  maxWaitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Requests the Sponsored Products reports of one profile for the last complete
 * window (ends 3 days ago), waits for them and stores the rows. Runs in the
 * scheduled workflow, never inside an HTTP request. A report that fails or
 * times out keeps the previously stored one and is returned as such.
 */
export async function syncAdsReports(
  client: AdsApiClient,
  store: AdsReportStore,
  profileId: string,
  options: AdsReportSyncOptions = {}
): Promise<AdsReportSyncResult[]> {
  const { startDate, endDate } = reportWindow(options.now ?? new Date());
  const kinds = options.kinds ?? ADS_REPORT_KINDS;
  const maxWaitMs = options.maxWaitMs ?? 30 * 60_000;
  const pollMs = options.pollMs ?? 30_000;
  const sleep = options.sleep ?? defaultSleep;

  const pending = new Map<AdsReportKind, string>();
  const results: AdsReportSyncResult[] = [];
  for (const kind of kinds) {
    try {
      pending.set(kind, await client.createReport(profileId, buildReportRequest(kind, startDate, endDate)));
    } catch (err) {
      results.push({ kind, status: "failed", error: errorText(err) });
    }
  }

  let waited = 0;
  while (pending.size > 0 && waited < maxWaitMs) {
    await sleep(pollMs);
    waited += pollMs;
    for (const [kind, reportId] of [...pending]) {
      try {
        const report = await client.getReport(profileId, reportId);
        if (report.status === "FAILED") {
          pending.delete(kind);
          results.push({ kind, status: "failed", error: report.failureReason ?? "FAILED" });
        } else if (report.status === "COMPLETED" && report.url) {
          pending.delete(kind);
          const rows = await client.downloadReport(report.url);
          await store.save({ profileId, kind, startDate, endDate, generatedAt: new Date().toISOString(), rows });
          results.push({ kind, status: "saved", rows: rows.length });
        }
      } catch (err) {
        pending.delete(kind);
        results.push({ kind, status: "failed", error: errorText(err) });
      }
    }
  }
  for (const kind of pending.keys()) {
    results.push({ kind, status: "timeout", error: `Amazon no completó el informe en ${Math.round(maxWaitMs / 60_000)} min` });
  }
  return results;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
