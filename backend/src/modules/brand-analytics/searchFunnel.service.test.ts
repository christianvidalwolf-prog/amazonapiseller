import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpApiClient } from "../../spapi/client";
import type { SearchQueryMetricsRepository } from "./searchFunnel.repository";
import { BUDGET_EXHAUSTED, SearchFunnelService } from "./searchFunnel.service";
import type { ReportPeriod, SearchQueryMetrics } from "./searchFunnel.types";

const ES = "A1RKKUPIHCS9HS";
const DE = "A1PA6795UKMFR9";
// 20 ASINs → two report batches (18 + 2).
const ASINS = Array.from({ length: 20 }, (_, i) => `B0${String(i).padStart(8, "0")}`);
const NOW = new Date("2026-10-15T10:00:00Z");

interface ReportRequest {
  marketplaceId: string;
  period: string;
  start: string;
  asins: string[];
}

/**
 * Amazon stand-in: every requested report answers DONE at once with one row per
 * ASIN. An unpublished period comes back empty, or FATAL with Amazon's
 * "not available yet" document when `fatal` is set — both happen in practice.
 */
function fakeAmazon(unpublished: string[] = [], fatal = false) {
  const requests: ReportRequest[] = [];
  const client = {
    request: async ({ method, path, body }: { method: string; path: string; body?: Record<string, unknown> }) => {
      if (method === "POST") {
        const options = body?.reportOptions as { reportPeriod: string; asin: string };
        requests.push({
          marketplaceId: (body?.marketplaceIds as string[])[0],
          period: options.reportPeriod,
          start: String(body?.dataStartTime).slice(0, 10),
          asins: options.asin.split(" "),
        });
        return { reportId: String(requests.length - 1) };
      }
      const id = path.split("/").pop() as string;
      if (path.includes("/documents/")) return { reportDocumentId: id, url: `https://amazon.example/${id}` };
      const failed = fatal && unpublished.includes(requests[Number(id)].start);
      return { reportId: id, processingStatus: failed ? "FATAL" : "DONE", reportDocumentId: id };
    },
  } as unknown as SpApiClient;

  vi.stubGlobal("fetch", async (url: string) => {
    const request = requests[Number(url.split("/").pop())];
    if (fatal && unpublished.includes(request.start)) {
      return new Response(
        JSON.stringify({ errorDetails: "Reporting data for end date [2026-09-30] and time period [monthly] is not available yet." })
      );
    }
    const dataByAsin = unpublished.includes(request.start)
      ? []
      : request.asins.map((asin) => ({
          startDate: request.start,
          endDate: request.start,
          asin,
          searchQueryData: { searchQuery: "cuarzo", searchQueryVolume: 100 },
          impressionData: { totalQueryImpressionCount: 1000, asinImpressionCount: 50 },
          clickData: { totalClickCount: 40, asinClickCount: 4 },
          cartAddData: { totalCartAddCount: 8, asinCartAddCount: 1 },
          purchaseData: { totalPurchaseCount: 2, asinPurchaseCount: 0 },
        }));
    return new Response(JSON.stringify({ dataByAsin }));
  });
  return { client, requests };
}

/** In-memory stand-in for the Supabase store. */
function fakeStore() {
  const rows = new Map<string, SearchQueryMetrics[]>();
  const asked = new Map<string, string[]>();
  const unavailable = new Map<string, string>();
  const scope = (marketplaceId: string, period: ReportPeriod) => `${marketplaceId}|${period}|`;
  const repository: SearchQueryMetricsRepository = {
    async replace(marketplaceId, period, range, asins, metrics) {
      const key = scope(marketplaceId, period) + range.periodStart;
      rows.set(key, [...(rows.get(key) ?? []).filter((m) => !asins.includes(m.asin)), ...metrics]);
      asked.set(key, [...new Set([...(asked.get(key) ?? []), ...asins])]);
    },
    async latest(marketplaceId, period, periods = 1) {
      const keys = [...rows.keys()].filter((key) => key.startsWith(scope(marketplaceId, period))).sort().reverse().slice(0, periods);
      const metrics = keys.flatMap((key) => rows.get(key) ?? []);
      const covered = Object.fromEntries(keys.map((key) => [key.split("|")[2], asked.get(key) ?? []]));
      return keys.length ? { updatedAt: NOW.toISOString(), metrics, covered } : null;
    },
    async unavailableSince(marketplaceId, period, start) {
      return unavailable.get(scope(marketplaceId, period) + start) ?? null;
    },
    async markUnavailable(marketplaceId, period, start) {
      unavailable.set(scope(marketplaceId, period) + start, new Date().toISOString());
    },
  };
  return { repository, rows, asked };
}

const service = (client: SpApiClient, repository: SearchQueryMetricsRepository | null, maxReports = 100) =>
  new SearchFunnelService(client, { marketplaceId: ES, asins: ASINS, brand: "", maxAsins: 36, maxReports }, repository);

describe("SearchFunnelService.sync", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("downloads a period once: a second sync asks Amazon for nothing", async () => {
    const amazon = fakeAmazon();
    const store = fakeStore();

    const first = await service(amazon.client, store.repository).sync({ period: "LAST_3_MONTHS" });
    expect(first).toMatchObject({ state: "done", requestedReports: 6, rows: 60, errors: [] });
    expect([...new Set(amazon.requests.map((r) => r.start))]).toEqual(["2026-09-01", "2026-08-01", "2026-07-01"]);

    // A fresh process (the next nightly run) finds everything in the store.
    const second = await service(amazon.client, store.repository).sync({ period: "LAST_3_MONTHS" });
    expect(second).toMatchObject({ state: "done", requestedReports: 0, rows: 60 });
    expect(amazon.requests).toHaveLength(6);

    // The 12-month view only needs the nine months not stored yet, and MONTH needs nothing.
    const year = await service(amazon.client, store.repository).sync({ period: "LAST_12_MONTHS" });
    expect(year).toMatchObject({ requestedReports: 18, rows: 240 });
    expect((await service(amazon.client, store.repository).sync({ period: "MONTH" })).requestedReports).toBe(0);
  });

  it("asks only for the ASINs a stored period was never asked about", async () => {
    const amazon = fakeAmazon();
    const store = fakeStore();
    // Someone refreshed a single ASIN first: the period exists but covers only that one.
    await service(amazon.client, store.repository).sync({ period: "MONTH", asin: ASINS[3] });
    amazon.requests.length = 0;

    const status = await service(amazon.client, store.repository).sync({ period: "MONTH" });
    expect(amazon.requests.flatMap((r) => r.asins).sort()).toEqual(ASINS.filter((asin) => asin !== ASINS[3]));
    expect(status).toMatchObject({ requestedReports: 2, rows: 20 });
  });

  it("does not ask again for an ASIN Amazon had no data for", async () => {
    const amazon = fakeAmazon();
    const store = fakeStore();
    await service(amazon.client, store.repository).sync({ period: "MONTH" });
    // ASIN 19 was requested but returned nothing: no row, yet still covered.
    const key = `${ES}|MONTH|2026-09-01`;
    store.rows.set(key, (store.rows.get(key) ?? []).filter((m) => m.asin !== ASINS[19]));

    expect((await service(amazon.client, store.repository).sync({ period: "MONTH" })).requestedReports).toBe(0);
  });

  it("without coverage data, takes a batch with any stored row as done", async () => {
    const amazon = fakeAmazon();
    const store = fakeStore();
    await service(amazon.client, store.repository).sync({ period: "MONTH" });
    // A store that tracks no coverage (the Prisma table), with the second batch lost to throttling.
    const key = `${ES}|MONTH|2026-09-01`;
    store.rows.set(key, (store.rows.get(key) ?? []).filter((m) => !ASINS.slice(18).includes(m.asin)));
    const latest = store.repository.latest.bind(store.repository);
    store.repository.latest = async (...args) => {
      const stored = await latest(...args);
      return stored && { updatedAt: stored.updatedAt, metrics: stored.metrics };
    };
    amazon.requests.length = 0;

    await service(amazon.client, store.repository).sync({ period: "MONTH" });
    expect(amazon.requests.map((r) => r.asins)).toEqual([ASINS.slice(18)]);
  });

  it("falls back one period when the newest is not published and does not ask for it again the same day", async () => {
    const amazon = fakeAmazon(["2026-09-01"]);
    const store = fakeStore();

    const first = await service(amazon.client, store.repository).sync({ period: "MONTH" });
    expect(first).toMatchObject({ state: "done", rows: 20, requestedReports: 4 });
    expect(amazon.requests.map((r) => r.start)).toEqual(["2026-09-01", "2026-09-01", "2026-08-01", "2026-08-01"]);

    const second = await service(amazon.client, store.repository).sync({ period: "MONTH" });
    expect(second).toMatchObject({ requestedReports: 0, rows: 20 });

    // A day later the unpublished month is checked again.
    vi.setSystemTime(new Date(NOW.getTime() + 21 * 3600 * 1000));
    const nextDay = await service(amazon.client, store.repository).sync({ period: "MONTH" });
    expect(nextDay.requestedReports).toBe(2);
  });

  it("treats Amazon's 'not available yet' failure as an unpublished period, not as an error", async () => {
    const amazon = fakeAmazon(["2026-09-01"], true);
    const store = fakeStore();

    const first = await service(amazon.client, store.repository).sync({ period: "MONTH" });
    expect(first).toMatchObject({ state: "done", rows: 20, errors: [] });
    expect((await service(amazon.client, store.repository).getFunnel({ period: "MONTH" })).periodStart).toBe("2026-08-01");
    expect((await service(amazon.client, store.repository).sync({ period: "MONTH" })).requestedReports).toBe(0);
  });

  it("keeps marketplaces apart", async () => {
    const amazon = fakeAmazon();
    const store = fakeStore();
    const funnel = service(amazon.client, store.repository);
    await funnel.sync({ period: "MONTH", marketplaceId: DE });

    expect(amazon.requests.every((r) => r.marketplaceId === DE)).toBe(true);
    expect((await funnel.getFunnel({ period: "MONTH", marketplaceId: DE })).asins).toHaveLength(20);
    expect((await funnel.getFunnel({ period: "MONTH" })).rows).toEqual([]);
  });

  it("stops at the report budget and picks up the rest once it refills", async () => {
    const amazon = fakeAmazon();
    const store = fakeStore();
    const funnel = service(amazon.client, store.repository, 3);

    const first = await funnel.sync({ period: "LAST_3_MONTHS" });
    expect(first).toMatchObject({ state: "done", requestedReports: 3, errors: [BUDGET_EXHAUSTED] });

    // Three minutes later three more reports are allowed, and only what is missing is asked for.
    vi.setSystemTime(new Date(NOW.getTime() + 3 * 60_000));
    const second = await funnel.sync({ period: "LAST_3_MONTHS" });
    expect(second).toMatchObject({ requestedReports: 3, rows: 60, errors: [] });
  });
});
