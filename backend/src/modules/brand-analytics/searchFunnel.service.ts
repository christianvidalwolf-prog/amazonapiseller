import fs from "node:fs";
import path from "node:path";
import type { SpApiClient } from "../../spapi/client";
import { createReport, downloadReportDocument, getReport, getReportDocument } from "../../spapi/endpoints/reports";
import { sleep } from "../../spapi/rateLimiter";
import { SpApiError } from "../../spapi/types";
import { aggregateByAsin, sortByImpact, summarizeFunnel, toFunnelRow } from "./searchFunnel.classifier";
import type { SearchQueryMetricsRepository, StoredSearchQueryMetrics } from "./searchFunnel.repository";
import {
  AGGREGATED_MONTHS,
  type FunnelPeriod,
  type FunnelStatus,
  isAggregatedPeriod,
  type ReportPeriod,
  type SearchFunnelResponse,
  type SearchFunnelSyncStatus,
  type SearchQueryMetrics,
} from "./searchFunnel.types";
import {
  chunkAsinsForReport,
  mergePeriods,
  parseSearchQueryPerformanceReport,
  reportPeriodRange,
  SEARCH_QUERY_PERFORMANCE_REPORT,
} from "./searchQueryReport";

const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 20 * 60_000;
const QUOTA_RETRY_MS = 90_000;
/** Amazon publishes a period a few days after it closes; fall back this many periods when it isn't there yet. */
const MAX_PERIODS_BACK = 1;
const DEFAULT_ROW_LIMIT = 5000;

export interface SearchFunnelConfig {
  marketplaceId: string;
  /** Explicit ASIN list to analyse. When empty, the top sellers of `brand` are used. */
  asins: string[];
  /** Only ASINs whose title starts with this brand are requested (Brand Analytics rejects foreign ASINs). */
  brand: string;
  maxAsins: number;
}

export interface SearchFunnelQuery {
  period: FunnelPeriod;
  asin?: string;
  status?: FunnelStatus;
  limit?: number;
}

interface ReportBatch {
  asins: string[];
  reportId: string;
}

export class SearchFunnelService {
  /** Synced metrics per report period (every period fetched by this process); what the endpoint serves when the database is unavailable (CI). */
  private readonly memory = new Map<ReportPeriod, StoredSearchQueryMetrics>();
  private running: Promise<SearchFunnelSyncStatus> | null = null;
  private status: SearchFunnelSyncStatus = {
    state: "idle",
    period: null,
    startedAt: null,
    finishedAt: null,
    requestedAsins: 0,
    rows: 0,
    errors: [],
  };

  constructor(
    private readonly client: SpApiClient,
    private readonly config: SearchFunnelConfig,
    private readonly repository: SearchQueryMetricsRepository | null
  ) {}

  getSyncStatus(): SearchFunnelSyncStatus {
    return this.status;
  }

  /** Starts a sync unless one is already running and returns without waiting for it. */
  startSync(period: FunnelPeriod, asin?: string): SearchFunnelSyncStatus {
    if (!this.running) {
      void this.sync(period, asin).catch(() => {
        // The failure is already recorded in `status`; nothing awaits this promise.
      });
    }
    return this.status;
  }

  /**
   * Requests, downloads and stores the report for the last complete period, or
   * for each of the last complete months when the period adds several up.
   * Concurrent calls share one run.
   */
  sync(period: FunnelPeriod, asin?: string): Promise<SearchFunnelSyncStatus> {
    if (this.running) return this.running;
    this.running = this.runSync(period, asin).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async getFunnel(query: SearchFunnelQuery): Promise<SearchFunnelResponse> {
    const period = query.period;
    const aggregated = isAggregatedPeriod(period);
    const stored = aggregated ? await this.loadLatest("MONTH", AGGREGATED_MONTHS[period]) : await this.loadLatest(period);
    const names = this.loadSalesByAsin();
    const periodMetrics = stored?.metrics ?? [];
    const metrics = (aggregated ? mergePeriods(periodMetrics) : periodMetrics).filter((m) => m.asinImpressions > 0);
    const starts = periodMetrics.map((m) => m.periodStart).sort();
    const ends = periodMetrics.map((m) => m.periodEnd).sort();

    const asins = [...new Set(metrics.map((m) => m.asin))]
      .map((asin) => ({ asin, name: names.get(asin)?.name ?? "" }))
      .sort((a, b) => a.asin.localeCompare(b.asin));

    const rows = metrics
      .filter((m) => !query.asin || m.asin === query.asin)
      .map(toFunnelRow)
      .filter((row) => !query.status || row.status === query.status);
    const asinRows = aggregateByAsin(metrics.filter((m) => !query.asin || m.asin === query.asin)).filter(
      (row) => !query.status || row.status === query.status
    );

    return {
      updatedAt: stored?.updatedAt ?? null,
      marketplaceId: this.config.marketplaceId,
      period: query.period,
      periodStart: starts[0] ?? null,
      periodEnd: ends[ends.length - 1] ?? null,
      asins,
      summary: summarizeFunnel(rows),
      rows: sortByImpact(rows).slice(0, query.limit ?? DEFAULT_ROW_LIMIT),
      asinRows: sortByImpact(asinRows),
    };
  }

  /** Metrics of the `periods` most recent stored periods: the database when it has any, else this process's memory. */
  private async loadLatest(period: ReportPeriod, periods = 1): Promise<StoredSearchQueryMetrics | null> {
    if (this.repository) {
      try {
        const stored = await this.repository.latest(this.config.marketplaceId, period, periods);
        if (stored) return stored;
      } catch (err) {
        console.warn(`[search-funnel] base de datos no disponible, se sirve la última sincronización en memoria: ${message(err)}`);
      }
    }
    const held = this.memory.get(period);
    if (!held) return null;
    const newest = new Set([...new Set(held.metrics.map((m) => m.periodStart))].sort().reverse().slice(0, periods));
    return { updatedAt: held.updatedAt, metrics: held.metrics.filter((m) => newest.has(m.periodStart)) };
  }

  private async runSync(period: FunnelPeriod, asin?: string): Promise<SearchFunnelSyncStatus> {
    const asins = asin ? [asin] : this.resolveAsins();
    this.status = {
      state: "running",
      period,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      requestedAsins: asins.length,
      rows: 0,
      errors: [],
    };

    try {
      if (!asins.length) {
        throw new Error("No hay ASINs que analizar: define SQP_ASINS o revisa SQP_BRAND / ventas_2026.csv.");
      }

      const { rows, errors } =
        isAggregatedPeriod(period)
          ? await this.syncMonths(asins, AGGREGATED_MONTHS[period], !asin)
          : await this.syncLatest(period, asins);
      this.status = {
        ...this.status,
        state: rows || !errors.length ? "done" : "failed",
        finishedAt: new Date().toISOString(),
        rows,
        errors,
      };
    } catch (err) {
      this.status = { ...this.status, state: "failed", finishedAt: new Date().toISOString(), errors: [message(err)] };
      throw err;
    }
    return this.status;
  }

  /** The last complete period, or the one before when Amazon has not published it yet. */
  private async syncLatest(period: ReportPeriod, asins: string[]): Promise<{ rows: number; errors: string[] }> {
    let metrics: SearchQueryMetrics[] = [];
    let errors: string[] = [];
    for (let periodsBack = 0; periodsBack <= MAX_PERIODS_BACK && !metrics.length; periodsBack++) {
      ({ metrics, errors } = await this.fetchPeriod(period, asins, periodsBack));
    }
    if (metrics.length) await this.store(period, asins, metrics);
    return { rows: metrics.length, errors };
  }

  /**
   * The last `months` complete months, each stored as its own MONTH
   * period. A closed month never changes, so with `reuseStored` only the report
   * batches that have nothing stored for a month are requested.
   */
  private async syncMonths(asins: string[], months: number, reuseStored: boolean): Promise<{ rows: number; errors: string[] }> {
    const held = reuseStored ? ((await this.loadLatest("MONTH", months + MAX_PERIODS_BACK))?.metrics ?? []) : [];
    const heldRows = (periodStart: string) => held.filter((m) => m.periodStart === periodStart);
    // Per report batch, not per month: a batch lost to throttling leaves the month half stored,
    // and the next sync must ask for that batch only.
    const missingAsins = (periodStart: string): string[] => {
      const stored = new Set(heldRows(periodStart).map((m) => m.asin));
      return chunkAsinsForReport(asins)
        .filter((chunk) => !chunk.some((asin) => stored.has(asin)))
        .flat();
    };

    let rows = 0;
    const errors: string[] = [];
    let newest = 0;
    for (let month = 0; month < months; month++) {
      let { periodStart } = reportPeriodRange("MONTH", new Date(), newest + month);
      let missing = missingAsins(periodStart);
      let fetched = missing.length ? await this.fetchPeriod("MONTH", missing, newest + month) : null;
      if (month === 0 && fetched && !fetched.metrics.length && !heldRows(periodStart).length && MAX_PERIODS_BACK > 0) {
        // The month that just closed is not published yet: the window starts one month earlier.
        newest = 1;
        ({ periodStart } = reportPeriodRange("MONTH", new Date(), newest));
        missing = missingAsins(periodStart);
        fetched = missing.length ? await this.fetchPeriod("MONTH", missing, newest) : null;
      }
      rows += heldRows(periodStart).length;
      if (!fetched) continue;
      errors.push(...fetched.errors);
      if (fetched.metrics.length) await this.store("MONTH", missing, fetched.metrics);
      rows += fetched.metrics.length;
    }
    return { rows, errors };
  }

  private async fetchPeriod(
    period: ReportPeriod,
    asins: string[],
    periodsBack: number
  ): Promise<{ metrics: SearchQueryMetrics[]; errors: string[] }> {
    const { periodStart, periodEnd } = reportPeriodRange(period, new Date(), periodsBack);
    const errors: string[] = [];
    const batches: ReportBatch[] = [];

    for (const chunk of chunkAsinsForReport(asins)) {
      const request = () =>
        createReport(this.client, {
          reportType: SEARCH_QUERY_PERFORMANCE_REPORT,
          marketplaceIds: [this.config.marketplaceId],
          dataStartTime: `${periodStart}T00:00:00Z`,
          dataEndTime: `${periodEnd}T00:00:00Z`,
          reportOptions: { reportPeriod: period, asin: chunk.join(" ") },
        });
      try {
        // createReport refills at one request per minute; a multi-month sync can drain the burst.
        const { reportId } = await request().catch(async (err) => {
          if (!(err instanceof SpApiError) || !err.isThrottled) throw err;
          await sleep(QUOTA_RETRY_MS);
          return request();
        });
        batches.push({ asins: chunk, reportId });
      } catch (err) {
        errors.push(`${periodStart} ${chunk.join(",")}: ${message(err)}`);
      }
    }

    const metrics: SearchQueryMetrics[] = [];
    for (const batch of batches) {
      try {
        metrics.push(...(await this.waitForReport(batch.reportId)));
      } catch (err) {
        errors.push(`${periodStart} ${batch.asins.join(",")}: ${message(err)}`);
      }
    }
    return { metrics, errors };
  }

  /** createReport → poll getReport until DONE → getReportDocument → download (gunzipped by the wrapper) → parse. */
  private async waitForReport(reportId: string): Promise<SearchQueryMetrics[]> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const report = await getReport(this.client, reportId);
      if (report.processingStatus === "DONE") {
        if (!report.reportDocumentId) return [];
        const document = await getReportDocument(this.client, report.reportDocumentId);
        return parseSearchQueryPerformanceReport((await downloadReportDocument(document)).toString("utf-8"));
      }
      if (report.processingStatus === "FATAL" || report.processingStatus === "CANCELLED") {
        throw new Error(`informe ${reportId} ${report.processingStatus}${await this.failureDetail(report.reportDocumentId)}`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`informe ${reportId} sin terminar tras ${POLL_TIMEOUT_MS / 60_000} min`);
  }

  /** A FATAL report usually carries a document explaining why (no access to the ASIN, period not published…). */
  private async failureDetail(reportDocumentId?: string): Promise<string> {
    if (!reportDocumentId) return "";
    try {
      const document = await getReportDocument(this.client, reportDocumentId);
      const body = (await downloadReportDocument(document)).toString("utf-8");
      return `: ${body.replace(/\s+/g, " ").slice(0, 300)}`;
    } catch {
      return "";
    }
  }

  private async store(period: ReportPeriod, asins: string[], metrics: SearchQueryMetrics[]): Promise<void> {
    // Only the refreshed ASINs of the refreshed periods are replaced: a single-ASIN
    // refresh keeps the other ASINs, and other months stay available for the multi-month views.
    const previous = this.memory.get(period)?.metrics ?? [];
    const refreshed = new Set(asins);
    const periods = new Set(metrics.map((m) => m.periodStart));
    const kept = previous.filter((m) => !(periods.has(m.periodStart) && refreshed.has(m.asin)));
    this.memory.set(period, { updatedAt: new Date().toISOString(), metrics: [...kept, ...metrics] });

    if (!this.repository) return;
    try {
      await this.repository.replace(this.config.marketplaceId, period, asins, metrics);
    } catch (err) {
      console.warn(`[search-funnel] no se pudo guardar en search_query_metrics: ${message(err)}`);
    }
  }

  private resolveAsins(): string[] {
    if (this.config.asins.length) return this.config.asins.slice(0, this.config.maxAsins);
    const brand = this.config.brand.toUpperCase();
    const products = [...this.loadSalesByAsin().entries()]
      .filter(([asin]) => /^[A-Z0-9]{10}$/.test(asin))
      .sort((a, b) => b[1].units - a[1].units);
    const branded = products
      .filter(([, product]) => !brand || product.name.toUpperCase().includes(brand))
      .slice(0, this.config.maxAsins)
      .map(([asin]) => asin);
    if (branded.length) return branded;

    // Algunos exports de ventas no incluyen la marca en el título (por ejemplo,
    // productos que empiezan por "Home Gadgets"). No debemos enviar una lista
    // vacía a Amazon: usamos los ASIN vendidos como fallback y dejamos trazado
    // el motivo para que se pueda configurar SQP_ASINS si se necesita precisión.
    if (products.length) {
      console.warn(`[search-funnel] SQP_BRAND="${this.config.brand}" no coincide con títulos; usando los ${Math.min(products.length, this.config.maxAsins)} ASIN más vendidos.`);
      return products.slice(0, this.config.maxAsins).map(([asin]) => asin);
    }
    return [];
  }

  /** Units sold and title per ASIN from the root sales export (same file the sales module reads). */
  private loadSalesByAsin(): Map<string, { name: string; units: number }> {
    const products = new Map<string, { name: string; units: number }>();
    const file = [path.resolve(process.cwd(), "..", "ventas_2026.csv"), path.resolve(process.cwd(), "ventas_2026.csv")].find(
      (candidate) => fs.existsSync(candidate)
    );
    if (!file) {
      this.loadInventoryAsins(products);
      return products;
    }

    const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
    const header = lines[0].replace(/^﻿/, "").split(";");
    const asinAt = header.indexOf("asin");
    const nameAt = header.indexOf("product-name");
    const quantityAt = header.indexOf("quantity");
    if (asinAt < 0) return products;

    for (const line of lines.slice(1)) {
      const cells = line.split(";");
      const asin = cells[asinAt]?.trim();
      if (!asin) continue;
      const product = products.get(asin) ?? { name: cells[nameAt]?.trim() ?? "", units: 0 };
      product.units += Number(cells[quantityAt]) || 0;
      products.set(asin, product);
    }
    if (!products.size) this.loadInventoryAsins(products);
    return products;
  }

  private loadInventoryAsins(products: Map<string, { name: string; units: number }>): void {
    const file = [
      path.resolve(process.cwd(), "..", "inventario_fba.csv"),
      path.resolve(process.cwd(), "inventario_fba.csv"),
      path.resolve(process.cwd(), "..", "inventario_fba_con_stock.csv"),
      path.resolve(process.cwd(), "inventario_fba_con_stock.csv"),
    ].find((candidate) => fs.existsSync(candidate));
    if (!file) return;

    const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return;
    const header = lines[0].replace(/^﻿/, "").split(";").map((value) => value.trim().toUpperCase());
    const asinAt = header.indexOf("ASIN");
    const nameAt = ["NOMBRE", "PRODUCT-NAME", "PRODUCT_NAME", "ITEM-NAME"].map((key) => header.indexOf(key)).find((index) => index >= 0) ?? -1;
    if (asinAt < 0) return;

    for (const line of lines.slice(1)) {
      const cells = line.split(";");
      const asin = cells[asinAt]?.trim().toUpperCase();
      if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) continue;
      if (!products.has(asin)) products.set(asin, { name: nameAt >= 0 ? cells[nameAt]?.trim() ?? "" : "", units: 0 });
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
