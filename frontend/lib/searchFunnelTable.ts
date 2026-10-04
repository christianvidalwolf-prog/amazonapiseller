import { FUNNEL_STATUSES, type FunnelStatus, type SearchFunnelRow } from "@/lib/searchFunnel";

/** Columns the table can be sorted by. The metric columns sort by their count or by their rate. */
export type SortKey =
  | "queryText"
  | "asin"
  | "totalQueryVolume"
  | "asinImpressions"
  | "asinImpressionShare"
  | "asinClicks"
  | "ctr"
  | "asinCartAdds"
  | "cartRate"
  | "asinPurchases"
  | "purchaseRate"
  | "status";

export interface TableSort {
  key: SortKey;
  direction: "asc" | "desc";
}

/** Columns with a "minimum value" filter. */
export const MINIMUM_KEYS = ["totalQueryVolume", "asinImpressions", "asinClicks", "asinCartAdds", "asinPurchases"] as const;
export type MinimumKey = (typeof MINIMUM_KEYS)[number];

export interface TableFilters {
  query: string;
  asin: string;
  status: FunnelStatus | "";
  /** Raw input text per column; empty or non-numeric means no filter. */
  minimums: Record<MinimumKey, string>;
}

export const EMPTY_FILTERS: TableFilters = {
  query: "",
  asin: "",
  status: "",
  minimums: { totalQueryVolume: "", asinImpressions: "", asinClicks: "", asinCartAdds: "", asinPurchases: "" },
};

const TEXT_KEYS: ReadonlySet<SortKey> = new Set(["queryText", "asin"]);

export function hasActiveFilters(filters: TableFilters): boolean {
  return Boolean(filters.query.trim() || filters.asin.trim() || filters.status || MINIMUM_KEYS.some((key) => filters.minimums[key].trim()));
}

/**
 * Header click cycle: first click sorts the way that is most useful for the
 * column (A→Z for text, largest first for numbers), second click reverses it,
 * third click goes back to the default order by impact.
 */
export function nextSort(current: TableSort | null, key: SortKey): TableSort | null {
  const first = TEXT_KEYS.has(key) ? "asc" : "desc";
  if (current?.key !== key) return { key, direction: first };
  if (current.direction === first) return { key, direction: first === "asc" ? "desc" : "asc" };
  return null;
}

export function filterRows(rows: SearchFunnelRow[], filters: TableFilters): SearchFunnelRow[] {
  const query = filters.query.trim().toLowerCase();
  const asin = filters.asin.trim().toUpperCase();
  const minimums = MINIMUM_KEYS.map((key) => [key, Number(filters.minimums[key].trim().replace(",", "."))] as const).filter(
    ([key, value]) => filters.minimums[key].trim() !== "" && Number.isFinite(value)
  );

  return rows.filter(
    (row) =>
      (!filters.status || row.status === filters.status) &&
      (!query || row.queryText.toLowerCase().includes(query)) &&
      (!asin || row.asin.includes(asin)) &&
      minimums.every(([key, value]) => row[key] >= value)
  );
}

/** `null` keeps the order the rows came in (by impact). Ties keep that order too. */
export function sortRows(rows: SearchFunnelRow[], sort: TableSort | null): SearchFunnelRow[] {
  if (!sort) return rows;
  const sign = sort.direction === "asc" ? 1 : -1;
  const compare = (a: SearchFunnelRow, b: SearchFunnelRow): number => {
    if (sort.key === "status") return FUNNEL_STATUSES.indexOf(a.status) - FUNNEL_STATUSES.indexOf(b.status);
    if (sort.key === "queryText" || sort.key === "asin") return a[sort.key].localeCompare(b[sort.key], "es");
    return a[sort.key] - b[sort.key];
  };
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => sign * compare(a.row, b.row) || a.index - b.index)
    .map(({ row }) => row);
}
