import fs from "node:fs";
import path from "node:path";
import type { SpApiClient } from "../../spapi/client";
import { createReport, downloadReportDocument, getReport, getReportDocument } from "../../spapi/endpoints/reports";
import { sleep } from "../../spapi/rateLimiter";
import { sortByImpact, summarizeFunnel, toFunnelRow } from "./searchFunnel.classifier";
import type { SearchQueryMetricsRepository, StoredSearchQueryMetrics } from "./searchFunnel.repository";
import type {
  FunnelStatus,
  ReportPeriod,
  SearchFunnelResponse,
  SearchFunnelSyncStatus,
  SearchQueryMetrics,
} from "./searchFunnel.types";
import {
  chunkAsinsForReport,
  parseSearchQueryPerformanceReport,
  reportPeriodRange,
  SEARCH_QUERY_PERFORMANCE_REPORT,
} from "./searchQueryReport";

const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 20 * 60_000;
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
  period: ReportPeriod;
  asin?: string;
  status?: FunnelStatus;
  limit?: number;
}

interface ReportBatch {
  asins: string[];
  reportId: string;
}

export class SearchFunnelService {
  /** Last synced metrics per period; what the endpoint serves when the database is unavailable (CI, Vercel build). */
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
  startSync(period: ReportPeriod, asin?: string): SearchFunnelSyncStatus {
    if (!this.running) {
      void this.sync(period, asin).catch(() => {
        // The failure is already recorded in `status`; nothing awaits this promise.
      });
    }
    return this.status;
  }

  /** Requests, downloads and stores the report for the last complete period. Concurrent calls share one run. */
  sync(period: ReportPeriod, asin?: string): Promise<SearchFunnelSyncStatus> {
    if (this.running) return this.running;
    this.running = this.runSync(period, asin).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async getFunnel(query: SearchFunnelQuery): Promise<SearchFunnelResponse> {
    const stored = await this.loadLatest(query.period);
    const names = this.loadSalesByAsin();
    const metrics = (stored?.metrics ?? []).filter((m) => m.asinImpressions > 0);

    const asins = [...new Set(metrics.map((m) => m.asin))]
      .map((asin) => ({ asin, name: names.get(asin)?.name ?? "" }))
      .sort((a, b) => a.asin.localeCompare(b.asin));

    const rows = metrics
      .filter((m) => !query.asin || m.asin === query.asin)
      .map(toFunnelRow)
      .filter((row) => !query.status || row.status === query.status);

    return {
      updatedAt: stored?.updatedAt ?? null,
      marketplaceId: this.config.marketplaceId,
      period: query.period,
      periodStart: metrics[0]?.periodStart ?? null,
      periodEnd: metrics[0]?.periodEnd ?? null,
      asins,
      summary: summarizeFunnel(rows),
      rows: sortByImpact(rows).slice(0, query.limit ?? DEFAULT_ROW_LIMIT),
    };
  }

  private async loadLatest(period: ReportPeriod): Promise<StoredSearchQueryMetrics | null> {
    if (this.repository) {
      try {
        const stored = await this.repository.latest(this.config.marketplaceId, period);
        if (stored) return stored;
      } catch (err) {
        console.warn(`[search-funnel] base de datos no disponible, se sirve la última sincronización en memoria: ${message(err)}`);
      }
    }
    return this.memory.get(period) ?? null;
  }

  private async runSync(period: ReportPeriod, asin?: string): Promise<SearchFunnelSyncStatus> {
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

      let metrics: SearchQueryMetrics[] = [];
      let errors: string[] = [];
      for (let periodsBack = 0; periodsBack <= MAX_PERIODS_BACK && !metrics.length; periodsBack++) {
        ({ metrics, errors } = await this.fetchPeriod(period, asins, periodsBack));
      }

      if (metrics.length) await this.store(period, asins, metrics);
      this.status = {
        ...this.status,
        state: metrics.length || !errors.length ? "done" : "failed",
        finishedAt: new Date().toISOString(),
        rows: metrics.length,
        errors,
      };
    } catch (err) {
      this.status = { ...this.status, state: "failed", finishedAt: new Date().toISOString(), errors: [message(err)] };
      throw err;
    }
    return this.status;
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
      try {
        const { reportId } = await createReport(this.client, {
          reportType: SEARCH_QUERY_PERFORMANCE_REPORT,
          marketplaceIds: [this.config.marketplaceId],
          dataStartTime: `${periodStart}T00:00:00Z`,
          dataEndTime: `${periodEnd}T00:00:00Z`,
          reportOptions: { reportPeriod: period, asin: chunk.join(" ") },
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
    // A single-ASIN refresh must not drop the other ASINs already held for the same period.
    const previous = this.memory.get(period)?.metrics ?? [];
    const refreshed = new Set(asins);
    const kept = previous.filter((m) => m.periodStart === metrics[0].periodStart && !refreshed.has(m.asin));
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
    return [...this.loadSalesByAsin().entries()]
      .filter(([, product]) => !brand || product.name.toUpperCase().startsWith(brand))
      .sort((a, b) => b[1].units - a[1].units)
      .slice(0, this.config.maxAsins)
      .map(([asin]) => asin);
  }

  /** Units sold and title per ASIN from the root sales export (same file the sales module reads). */
  private loadSalesByAsin(): Map<string, { name: string; units: number }> {
    const products = new Map<string, { name: string; units: number }>();
    const file = [path.resolve(process.cwd(), "..", "ventas_2026.csv"), path.resolve(process.cwd(), "ventas_2026.csv")].find(
      (candidate) => fs.existsSync(candidate)
    );
    if (!file) return products;

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
    return products;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
