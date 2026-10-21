/**
 * Change Log of advertising decisions (spec advertising §9, skill step 6.5). Every human
 * decision on a proposal is recorded with its baseline metric and a review date (+14 days).
 * While an entity is "maturing" (approved < 14 days ago) it gets no new proposal: attribution
 * needs time and the same variable must not be changed twice.
 */

export const REVIEW_AFTER_DAYS = 14;
const MAX_ENTRIES = 1000;

export interface ChangeLogEntry {
  /** Proposal id (adGroupId|type|text). */
  entityId: string;
  date: string;
  profileId: string;
  country?: string;
  entityType: string;
  text: string;
  action: "approved" | "rejected" | "applied" | "reverted";
  oldValue: string | null;
  newValue: string | null;
  /** Metric at decision time, to compare at review (e.g. "30 clics, 9 € gasto, 0 ventas"). */
  baselineMetric: string;
  reviewDate: string;
  reason: string;
}

export const changelogKey = (profileId: string) => `ads:changelog:${profileId}`;

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);
}

export function appendEntry(log: ChangeLogEntry[], entry: ChangeLogEntry): ChangeLogEntry[] {
  return [entry, ...log].slice(0, MAX_ENTRIES);
}

/** Entities approved or applied less than REVIEW_AFTER_DAYS ago, with the date they mature. */
export function maturingEntities(log: ChangeLogEntry[], now = new Date()): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of log) {
    if ((e.action === "approved" || e.action === "applied") && e.reviewDate > now.toISOString().slice(0, 10) && !out.has(e.entityId)) {
      out.set(e.entityId, e.reviewDate);
    }
  }
  return out;
}
