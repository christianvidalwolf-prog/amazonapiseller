import fs from "node:fs";
import path from "node:path";
import type { SpApiClient } from "../../spapi/client";
import { createReport, downloadReportDocument, getReport, getReportDocument } from "../../spapi/endpoints/reports";
import { sleep } from "../../spapi/rateLimiter";
import { SpApiError } from "../../spapi/types";
import { BSR_MARKETPLACES } from "../bsr/bsr.marketplaces";
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
/** A period Amazon had not published is not asked for again until this long has passed. */
const UNAVAILABLE_RECHECK_MS = 20 * 3600 * 1000;
/** createReport refills at one request per minute on Amazon's side; the budget mirrors it. */
const REPORT_REFILL_MS = 60_000;
const DEFAULT_ROW_LIMIT = 5000;
/** What Amazon's FATAL report says for a period that closed but is not processed yet. */
const NOT_PUBLISHED_YET = /is not available yet/i;
export const BUDGET_EXHAUSTED = "presupuesto de informes agotado; lo que falta se pedirá en la siguiente sincronización";

export interface SearchFunnelConfig {
  /** Marketplace used when a request names none. */
  marketplaceId: string;
  /** Explicit ASIN list to analyse. When empty, the top sellers of `brand` in the marketplace are used. */
  asins: string[];
  /** Only ASINs whose title carries this brand are requested (Brand Analytics rejects foreign ASINs). */
  brand: string;
  maxAsins: number;
  /** Reports this process may request in a burst before it has to wait for the refill. */
  maxReports: number;
}

export interface SearchFunnelQuery {
  period: FunnelPeriod;
  marketplaceId?: string;
  asin?: string;
  status?: FunnelStatus;
  limit?: number;
}

export interface SearchFunnelSyncRequest {
  period: FunnelPeriod;
  marketplaceId?: string;
  asin?: string;
}

interface ReportBatch {
  asins: string[];
  reportId: string;
}

interface PeriodFetch {
  metrics: SearchQueryMetrics[];
  errors: string[];
  /** Reports Amazon accepted, so "no rows" can be told apart from "nothing was asked". */
  requested: number;
  /** Amazon said the period is not out yet (it fails the report with that message rather than returning it empty). */
  unpublished: boolean;
}

export class SearchFunnelService {
  /**
   * Metrics fetched by this process, per marketplace and report period: what the
   * endpoint serves when no store is reachable.
   */
  private readonly memory = new Map<string, StoredSearchQueryMetrics>();
  private running: Promise<SearchFunnelSyncStatus> | null = null;
  private reportTokens: number;
  private lastRefill = Date.now();
  private status: SearchFunnelSyncStatus = {
    state: "idle",
    marketplaceId: null,
    period: null,
    startedAt: null,
    finishedAt: null,
    requestedAsins: 0,
    rows: 0,
    requestedReports: 0,
    errors: [],
  };

  constructor(
    private readonly client: SpApiClient,
    private readonly config: SearchFunnelConfig,
    private readonly repository: SearchQueryMetricsRepository | null
  ) {
    this.reportTokens = config.maxReports;
  }

  getSyncStatus(): SearchFunnelSyncStatus {
    return this.status;
  }

  /** Starts a sync unless one is already running and returns without waiting for it. */
  startSync(request: SearchFunnelSyncRequest): SearchFunnelSyncStatus {
    if (!this.running) {
      void this.sync(request).catch(() => {
        // The failure is already recorded in `status`; nothing awaits this promise.
      });
    }
    return this.status;
  }

  /**
   * Brings the store up to date for the periods the view needs and asks Amazon
   * only for what is missing: a closed week or month never changes, so once
   * stored it is not requested again. Concurrent calls share one run.
   */
  sync(request: SearchFunnelSyncRequest): Promise<SearchFunnelSyncStatus> {
    if (this.running) return this.running;
    this.running = this.runSync(request).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async getFunnel(query: SearchFunnelQuery): Promise<SearchFunnelResponse> {
    const marketplaceId = query.marketplaceId ?? this.config.marketplaceId;
    const period = query.period;
    const aggregated = isAggregatedPeriod(period);
    const stored = aggregated
      ? await this.loadLatest(marketplaceId, "MONTH", AGGREGATED_MONTHS[period])
      : await this.loadLatest(marketplaceId, period);
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
      marketplaceId,
      period: query.period,
      periodStart: starts[0] ?? null,
      periodEnd: ends[ends.length - 1] ?? null,
      asins,
      summary: summarizeFunnel(rows),
      rows: sortByImpact(rows).slice(0, query.limit ?? DEFAULT_ROW_LIMIT),
      asinRows: sortByImpact(asinRows),
    };
  }

  /** Metrics of the `periods` most recent stored periods: the store when it has any, else this process's memory. */
  private async loadLatest(marketplaceId: string, period: ReportPeriod, periods = 1): Promise<StoredSearchQueryMetrics | null> {
    if (this.repository) {
      try {
        const stored = await this.repository.latest(marketplaceId, period, periods);
        if (stored) return stored;
      } catch (err) {
        console.warn(`[search-funnel] almacén no disponible, se sirve la última sincronización en memoria: ${message(err)}`);
      }
    }
    const held = this.memory.get(`${marketplaceId}|${period}`);
    if (!held) return null;
    const newest = new Set([...new Set(held.metrics.map((m) => m.periodStart))].sort().reverse().slice(0, periods));
    return { updatedAt: held.updatedAt, metrics: held.metrics.filter((m) => newest.has(m.periodStart)) };
  }

  private async runSync(request: SearchFunnelSyncRequest): Promise<SearchFunnelSyncStatus> {
    const marketplaceId = request.marketplaceId ?? this.config.marketplaceId;
    const { period, asin } = request;
    const asins = asin ? [asin] : this.resolveAsins(marketplaceId);
    this.status = {
      state: "running",
      marketplaceId,
      period,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      requestedAsins: asins.length,
      rows: 0,
      requestedReports: 0,
      errors: [],
    };

    try {
      if (!asins.length) {
        throw new Error("No hay ASINs que analizar: define SQP_ASINS o revisa SQP_BRAND / ventas_2026.csv.");
      }
      const reportPeriod: ReportPeriod = isAggregatedPeriod(period) ? "MONTH" : period;
      const periods = isAggregatedPeriod(period) ? AGGREGATED_MONTHS[period] : 1;
      // Refreshing one ASIN is an explicit request for that ASIN, so its stored rows are not reused.
      const { rows, errors, requested } = await this.syncPeriods(marketplaceId, reportPeriod, periods, asins, !asin);
      this.status = {
        ...this.status,
        state: rows || !errors.length ? "done" : "failed",
        finishedAt: new Date().toISOString(),
        rows,
        requestedReports: requested,
        errors,
      };
    } catch (err) {
      this.status = { ...this.status, state: "failed", finishedAt: new Date().toISOString(), errors: [message(err)] };
      throw err;
    }
    return this.status;
  }

  /**
   * Makes sure the last `periods` complete periods are stored. With
   * `reuseStored`, only the report batches that have nothing stored for a
   * period are requested, so a batch lost to throttling is recovered by the
   * next sync and everything else costs no request. When Amazon has not
   * published the period that just closed, the window starts one earlier.
   */
  private async syncPeriods(
    marketplaceId: string,
    period: ReportPeriod,
    periods: number,
    asins: string[],
    reuseStored: boolean
  ): Promise<{ rows: number; errors: string[]; requested: number }> {
    const held = reuseStored ? ((await this.loadLatest(marketplaceId, period, periods + MAX_PERIODS_BACK))?.metrics ?? []) : [];
    const heldRows = (periodStart: string) => held.filter((m) => m.periodStart === periodStart);
    const missingAsins = (periodStart: string): string[] => {
      const stored = new Set(heldRows(periodStart).map((m) => m.asin));
      return chunkAsinsForReport(asins)
        .filter((chunk) => !chunk.some((asin) => stored.has(asin)))
        .flat();
    };
    const startOf = (periodsBack: number) => reportPeriodRange(period, new Date(), periodsBack).periodStart;

    let rows = 0;
    let requested = 0;
    const errors: string[] = [];
    // Skip the period that just closed without asking when Amazon said recently that it is not out yet.
    let newest = !heldRows(startOf(0)).length && (await this.wasUnavailable(marketplaceId, period, startOf(0))) ? 1 : 0;

    for (let index = 0; index < periods; index++) {
      let periodStart = startOf(newest + index);
      let missing = missingAsins(periodStart);
      let fetched = missing.length ? await this.fetchPeriod(marketplaceId, period, missing, newest + index) : null;
      requested += fetched?.requested ?? 0;

      const notPublished =
        fetched && fetched.requested > 0 && !fetched.metrics.length && (fetched.unpublished || !fetched.errors.length);
      if (index === 0 && newest === 0 && notPublished && !heldRows(periodStart).length) {
        await this.rememberUnavailable(marketplaceId, period, periodStart);
        newest = 1;
        periodStart = startOf(newest);
        missing = missingAsins(periodStart);
        fetched = missing.length ? await this.fetchPeriod(marketplaceId, period, missing, newest) : null;
        requested += fetched?.requested ?? 0;
      }

      rows += heldRows(periodStart).length;
      if (!fetched) continue;
      errors.push(...fetched.errors);
      if (fetched.metrics.length) await this.store(marketplaceId, period, missing, fetched.metrics);
      rows += fetched.metrics.length;
    }
    return { rows, errors: [...new Set(errors)], requested };
  }

  private async wasUnavailable(marketplaceId: string, period: ReportPeriod, periodStart: string): Promise<boolean> {
    try {
      const checkedAt = await this.repository?.unavailableSince?.(marketplaceId, period, periodStart);
      return !!checkedAt && Date.now() - Date.parse(checkedAt) < UNAVAILABLE_RECHECK_MS;
    } catch {
      return false;
    }
  }

  private async rememberUnavailable(marketplaceId: string, period: ReportPeriod, periodStart: string): Promise<void> {
    try {
      await this.repository?.markUnavailable?.(marketplaceId, period, periodStart);
    } catch (err) {
      console.warn(`[search-funnel] no se pudo anotar el período sin publicar: ${message(err)}`);
    }
  }

  /** One token per report; false when the burst is spent and the minute-by-minute refill has not caught up. */
  private takeReportToken(): boolean {
    const refilled = Math.floor((Date.now() - this.lastRefill) / REPORT_REFILL_MS);
    if (refilled > 0) {
      this.reportTokens = Math.min(this.config.maxReports, this.reportTokens + refilled);
      this.lastRefill += refilled * REPORT_REFILL_MS;
    }
    if (this.reportTokens <= 0) return false;
    this.reportTokens -= 1;
    return true;
  }

  private async fetchPeriod(marketplaceId: string, period: ReportPeriod, asins: string[], periodsBack: number): Promise<PeriodFetch> {
    const { periodStart, periodEnd } = reportPeriodRange(period, new Date(), periodsBack);
    const errors: string[] = [];
    const batches: ReportBatch[] = [];

    for (const chunk of chunkAsinsForReport(asins)) {
      if (!this.takeReportToken()) {
        errors.push(BUDGET_EXHAUSTED);
        break;
      }
      const request = () =>
        createReport(this.client, {
          reportType: SEARCH_QUERY_PERFORMANCE_REPORT,
          marketplaceIds: [marketplaceId],
          dataStartTime: `${periodStart}T00:00:00Z`,
          dataEndTime: `${periodEnd}T00:00:00Z`,
          reportOptions: { reportPeriod: period, asin: chunk.join(" ") },
        });
      try {
        // createReport refills at one request per minute; other jobs on the account share that quota.
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
    let unpublished = false;
    for (const batch of batches) {
      try {
        metrics.push(...(await this.waitForReport(batch.reportId)));
      } catch (err) {
        if (NOT_PUBLISHED_YET.test(message(err))) unpublished = true;
        else errors.push(`${periodStart} ${batch.asins.join(",")}: ${message(err)}`);
      }
    }
    return { metrics, errors, requested: batches.length, unpublished };
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

  private async store(marketplaceId: string, period: ReportPeriod, asins: string[], metrics: SearchQueryMetrics[]): Promise<void> {
    // Only the refreshed ASINs of the refreshed periods are replaced: a single-ASIN
    // refresh keeps the other ASINs, and other periods stay available for the multi-month views.
    const memoryKey = `${marketplaceId}|${period}`;
    const previous = this.memory.get(memoryKey)?.metrics ?? [];
    const refreshed = new Set(asins);
    const periods = new Set(metrics.map((m) => m.periodStart));
    const kept = previous.filter((m) => !(periods.has(m.periodStart) && refreshed.has(m.asin)));
    this.memory.set(memoryKey, { updatedAt: new Date().toISOString(), metrics: [...kept, ...metrics] });

    if (!this.repository) return;
    try {
      await this.repository.replace(marketplaceId, period, asins, metrics);
    } catch (err) {
      console.warn(`[search-funnel] no se pudieron guardar las métricas: ${message(err)}`);
    }
  }

  /** SQP_ASINS when set; otherwise the brand's best sellers in that marketplace (in any, if it has no sales yet). */
  private resolveAsins(marketplaceId: string): string[] {
    if (this.config.asins.length) return this.config.asins.slice(0, this.config.maxAsins);
    const brand = this.config.brand.toUpperCase();
    const salesChannel = BSR_MARKETPLACES.find((m) => m.id === marketplaceId)?.salesChannel;
    const local = this.loadSalesByAsin(salesChannel);
    const products = [...(local.size ? local : this.loadSalesByAsin()).entries()]
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
  private loadSalesByAsin(salesChannel?: string): Map<string, { name: string; units: number }> {
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
    const channelAt = header.indexOf("sales-channel");
    if (asinAt < 0) return products;

    for (const line of lines.slice(1)) {
      const cells = line.split(";");
      const asin = cells[asinAt]?.trim();
      if (!asin) continue;
      if (salesChannel && cells[channelAt]?.trim().toLowerCase() !== salesChannel.toLowerCase()) continue;
      const product = products.get(asin) ?? { name: cells[nameAt]?.trim() ?? "", units: 0 };
      product.units += Number(cells[quantityAt]) || 0;
      products.set(asin, product);
    }
    if (!products.size && !salesChannel) this.loadInventoryAsins(products);
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
