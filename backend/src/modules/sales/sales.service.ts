import fs from "node:fs";
import path from "node:path";
import type { SpApiClient } from "../../spapi/client";
import { createReport, downloadReportDocument, getReport, getReportDocument } from "../../spapi/endpoints/reports";
import { sleep } from "../../spapi/rateLimiter";

const REPORT_TYPE = "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL";
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40;

export interface DailySalesRecord {
  date: string; // "YYYY-MM-DD"
  revenue: number;
  units: number;
  // Year-over-year same calendar day comparison
  prevYearDate: string; // "YYYY-1-MM-DD"
  prevYearRevenue: number;
  prevYearUnits: number;
  revenueDiff: number; // revenue - prevYearRevenue
  revenueGrowthPct: number | null; // ((revenue - prevYearRevenue) / prevYearRevenue) * 100
  unitsDiff: number;
  unitsGrowthPct: number | null;
}

export interface WeeklySalesRecord {
  weekStart: string;
  weekEnd: string;
  revenue: number;
  units: number;
  orders: number;
  prevYearRevenue: number;
  prevYearUnits: number;
  revenueGrowthPct: number | null;
}

export interface SalesSummary {
  totalRevenue: number;
  totalUnits: number;
  uniqueOrders: number;
  orderLines: number;
  // YoY comparison metrics
  prevYearTotalRevenue: number;
  prevYearTotalUnits: number;
  revenueGrowthYoY: number | null;
  unitsGrowthYoY: number | null;
  hasPreviousYearData: boolean;

  byChannel: Array<{ channel: string; revenue: number }>;
  byFulfillment: Array<{ channel: string; units: number }>;
  byDay: DailySalesRecord[];
  byWeek: WeeklySalesRecord[];
  topProducts: Array<{ sku: string; name: string; units: number; revenue: number }>;
}

export const GLOBAL_CHANNEL = "ALL";

export interface SalesReport {
  /** Sales-channel values found in the data (e.g. "Amazon.es", "Amazon.de"), sorted. */
  availableChannels: string[];
  /** Keyed by channel name, plus GLOBAL_CHANNEL for every country combined. */
  summaries: Record<string, SalesSummary>;
}

/** Monday (UTC) of the ISO week containing `dateStr` ("YYYY-MM-DD"). */
function weekStartOf(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  const day = date.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diffToMonday);
  return date.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Shifts date string back exactly one year ("2026-09-19" -> "2025-09-19"). Handles leap year 02-29. */
export function shiftOneYearBack(isoOrDateStr: string): string {
  if (!isoOrDateStr) return "";
  const match = isoOrDateStr.match(/^(\d{4})-(.*)$/);
  if (match) {
    const prevYear = parseInt(match[1], 10) - 1;
    if (match[2].startsWith("02-29")) {
      return `${prevYear}-02-28${match[2].slice(5)}`;
    }
    return `${prevYear}-${match[2]}`;
  }
  return isoOrDateStr;
}

export class SalesService {
  constructor(private readonly client: SpApiClient, private readonly marketplaceIds: string[]) {}

  /**
   * Requests or loads order data for current period and matching prior-year window,
   * returning consolidated metrics with day-by-day YoY comparisons.
   */
  async getSalesSummary(dataStartTime: string, dataEndTime: string): Promise<SalesSummary> {
    const { currentRows, prevYearRows } = await this.loadRowsWithHistory(dataStartTime, dataEndTime);
    return aggregate(currentRows, prevYearRows);
  }

  /**
   * Same underlying row fetch as getSalesSummary, but aggregated once per
   * sales channel (country) plus once for every channel combined (GLOBAL_CHANNEL).
   */
  async getSalesReport(dataStartTime: string, dataEndTime: string): Promise<SalesReport> {
    const { currentRows, prevYearRows } = await this.loadRowsWithHistory(dataStartTime, dataEndTime);

    const availableChannels = [...new Set(currentRows.map((row) => row["sales-channel"] || "Desconocido"))].sort();

    const summaries: Record<string, SalesSummary> = {
      [GLOBAL_CHANNEL]: aggregate(currentRows, prevYearRows),
    };
    for (const channel of availableChannels) {
      summaries[channel] = aggregate(
        currentRows.filter((row) => (row["sales-channel"] || "Desconocido") === channel),
        prevYearRows.filter((row) => (row["sales-channel"] || "Desconocido") === channel)
      );
    }

    return { availableChannels, summaries };
  }

  private async loadRowsWithHistory(
    dataStartTime: string,
    dataEndTime: string
  ): Promise<{ currentRows: Record<string, string>[]; prevYearRows: Record<string, string>[] }> {
    const currentRows = await this.loadRows(dataStartTime, dataEndTime, "ventas_2026.csv");

    const prevStart = shiftOneYearBack(dataStartTime);
    const prevEnd = shiftOneYearBack(dataEndTime);
    const prevYearRows = await this.loadRows(prevStart, prevEnd, "ventas_2025.csv");

    return { currentRows, prevYearRows };
  }

  private async loadRows(
    dataStartTime: string,
    dataEndTime: string,
    preferredCsvFilename = "ventas_2026.csv"
  ): Promise<Record<string, string>[]> {
    // 1. Intentar cargar desde el archivo CSV local correspondiente
    const csvPath = path.resolve(process.cwd(), "..", preferredCsvFilename);
    const altCsvPath = path.resolve(process.cwd(), preferredCsvFilename);
    const targetPath = fs.existsSync(csvPath) ? csvPath : fs.existsSync(altCsvPath) ? altCsvPath : null;

    if (targetPath) {
      try {
        const text = fs.readFileSync(targetPath, "utf-8");
        const rows = parseCsvSemicolon(text);
        if (rows.length > 0) {
          // Filtrar por rango si se especifica
          const filtered = rows.filter((r) => {
            const date = r["purchase-date"] ?? "";
            if (!date) return true;
            if (dataStartTime && date < dataStartTime) return false;
            if (dataEndTime && date > dataEndTime) return false;
            return true;
          });
          return filtered.length > 0 ? filtered : rows;
        }
      } catch (err) {
        console.warn(`No se pudo leer ${preferredCsvFilename} local:`, err);
      }
    }

    // Si es 2025 y no hay CSV, no llamamos a SP-API de forma síncrona en cada petición para no bloquear
    if (preferredCsvFilename.includes("2025")) {
      return [];
    }

    return this.fetchOrderRows(dataStartTime, dataEndTime);
  }

  private async fetchOrderRows(dataStartTime: string, dataEndTime: string): Promise<Record<string, string>[]> {
    const { reportId } = await createReport(this.client, {
      reportType: REPORT_TYPE,
      marketplaceIds: this.marketplaceIds,
      dataStartTime,
      dataEndTime,
    });

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      await sleep(POLL_INTERVAL_MS);
      const status = await getReport(this.client, reportId);

      if (status.processingStatus === "DONE") {
        if (!status.reportDocumentId) return [];
        const document = await getReportDocument(this.client, status.reportDocumentId);
        const buffer = await downloadReportDocument(document);
        return parseTabDelimited(buffer.toString("latin1"));
      }

      if (status.processingStatus === "FATAL" || status.processingStatus === "CANCELLED") {
        throw new Error(`Report ${reportId} ended with status ${status.processingStatus}`);
      }
    }

    throw new Error(`Report ${reportId} did not finish within ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`);
  }
}

function parseTabDelimited(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length <= 1) return [];

  const headers = lines[0].split("\t");
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split("\t");
    if (parts.length !== headers.length) continue;
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = parts[index];
    });
    rows.push(row);
  }
  return rows;
}

function parseCsvSemicolon(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length <= 1) return [];

  const headers = lines[0].replace(/^\uFEFF/, "").split(";");
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(";");
    if (parts.length !== headers.length) continue;
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = parts[index];
    });
    rows.push(row);
  }
  return rows;
}

function aggregate(rows: Record<string, string>[], prevYearRows: Record<string, string>[] = []): SalesSummary {
  const validRows = rows.filter((row) => (row["order-status"] ?? "").toLowerCase() !== "cancelled");
  const validPrevRows = prevYearRows.filter((row) => (row["order-status"] ?? "").toLowerCase() !== "cancelled");

  // Previous year lookup maps by day and week
  const prevByDay = new Map<string, { revenue: number; units: number }>();
  const prevByWeek = new Map<string, { revenue: number; units: number }>();
  let prevYearTotalRevenue = 0;
  let prevYearTotalUnits = 0;

  for (const row of validPrevRows) {
    const quantity = Number.parseInt(row["quantity"] ?? "1", 10) || 1;
    const price = Number.parseFloat((row["item-price"] ?? "0").replace(",", ".")) || 0;
    prevYearTotalRevenue += price;
    prevYearTotalUnits += quantity;

    const day = (row["purchase-date"] ?? "").slice(0, 10);
    if (day) {
      const entry = prevByDay.get(day) ?? { revenue: 0, units: 0 };
      entry.revenue += price;
      entry.units += quantity;
      prevByDay.set(day, entry);

      const weekStart = weekStartOf(day);
      const wEntry = prevByWeek.get(weekStart) ?? { revenue: 0, units: 0 };
      wEntry.revenue += price;
      wEntry.units += quantity;
      prevByWeek.set(weekStart, wEntry);
    }
  }

  const orderIds = new Set<string>();
  const byChannel = new Map<string, number>();
  const byFulfillment = new Map<string, number>();
  const byDay = new Map<string, { revenue: number; units: number }>();
  const byWeek = new Map<string, { revenue: number; units: number; orders: Set<string> }>();
  const byProduct = new Map<string, { name: string; units: number; revenue: number }>();

  let totalRevenue = 0;
  let totalUnits = 0;

  for (const row of validRows) {
    const orderId = row["amazon-order-id"] ?? "";
    if (orderId) orderIds.add(orderId);

    const quantity = Number.parseInt(row["quantity"] ?? "1", 10) || 1;
    totalUnits += quantity;

    const price = Number.parseFloat((row["item-price"] ?? "0").replace(",", ".")) || 0;
    totalRevenue += price;

    const channel = row["sales-channel"] || "Desconocido";
    byChannel.set(channel, (byChannel.get(channel) ?? 0) + price);

    const fulfillment = row["fulfillment-channel"] || "Desconocido";
    byFulfillment.set(fulfillment, (byFulfillment.get(fulfillment) ?? 0) + quantity);

    const day = (row["purchase-date"] ?? "").slice(0, 10);
    if (day) {
      const dayEntry = byDay.get(day) ?? { revenue: 0, units: 0 };
      dayEntry.revenue += price;
      dayEntry.units += quantity;
      byDay.set(day, dayEntry);

      const weekStart = weekStartOf(day);
      const weekEntry = byWeek.get(weekStart) ?? { revenue: 0, units: 0, orders: new Set<string>() };
      weekEntry.revenue += price;
      weekEntry.units += quantity;
      if (orderId) weekEntry.orders.add(orderId);
      byWeek.set(weekStart, weekEntry);
    }

    const sku = row["sku"] || "Sin SKU";
    const name = (row["product-name"] ?? "").slice(0, 80);
    const existing = byProduct.get(sku) ?? { name, units: 0, revenue: 0 };
    existing.units += quantity;
    existing.revenue += price;
    byProduct.set(sku, existing);
  }

  // Format daily records with YoY same-calendar-day comparisons
  const formattedByDay: DailySalesRecord[] = [...byDay.entries()]
    .map(([date, data]) => {
      const prevYearDate = shiftOneYearBack(date);
      const prev = prevByDay.get(prevYearDate) ?? { revenue: 0, units: 0 };
      const revenueDiff = data.revenue - prev.revenue;
      const revenueGrowthPct = prev.revenue > 0 ? ((data.revenue - prev.revenue) / prev.revenue) * 100 : null;
      const unitsDiff = data.units - prev.units;
      const unitsGrowthPct = prev.units > 0 ? ((data.units - prev.units) / prev.units) * 100 : null;

      return {
        date,
        revenue: Number(data.revenue.toFixed(2)),
        units: data.units,
        prevYearDate,
        prevYearRevenue: Number(prev.revenue.toFixed(2)),
        prevYearUnits: prev.units,
        revenueDiff: Number(revenueDiff.toFixed(2)),
        revenueGrowthPct: revenueGrowthPct !== null ? Number(revenueGrowthPct.toFixed(1)) : null,
        unitsDiff,
        unitsGrowthPct: unitsGrowthPct !== null ? Number(unitsGrowthPct.toFixed(1)) : null,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  // Format weekly records with YoY comparisons
  const formattedByWeek: WeeklySalesRecord[] = [...byWeek.entries()]
    .map(([weekStart, data]) => {
      // 52 weeks back keeps the Monday alignment; a calendar-date shift lands mid-week and never matches prevByWeek keys.
      const prevWeekStart = addDays(weekStart, -364);
      const prev = prevByWeek.get(prevWeekStart) ?? { revenue: 0, units: 0 };
      const revenueGrowthPct = prev.revenue > 0 ? ((data.revenue - prev.revenue) / prev.revenue) * 100 : null;

      return {
        weekStart,
        weekEnd: addDays(weekStart, 6),
        revenue: Number(data.revenue.toFixed(2)),
        units: data.units,
        orders: data.orders.size,
        prevYearRevenue: Number(prev.revenue.toFixed(2)),
        prevYearUnits: prev.units,
        revenueGrowthPct: revenueGrowthPct !== null ? Number(revenueGrowthPct.toFixed(1)) : null,
      };
    })
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  const revenueGrowthYoY =
    prevYearTotalRevenue > 0 ? ((totalRevenue - prevYearTotalRevenue) / prevYearTotalRevenue) * 100 : null;
  const unitsGrowthYoY =
    prevYearTotalUnits > 0 ? ((totalUnits - prevYearTotalUnits) / prevYearTotalUnits) * 100 : null;

  return {
    totalRevenue: Number(totalRevenue.toFixed(2)),
    totalUnits,
    uniqueOrders: orderIds.size,
    orderLines: validRows.length,
    prevYearTotalRevenue: Number(prevYearTotalRevenue.toFixed(2)),
    prevYearTotalUnits,
    revenueGrowthYoY: revenueGrowthYoY !== null ? Number(revenueGrowthYoY.toFixed(1)) : null,
    unitsGrowthYoY: unitsGrowthYoY !== null ? Number(unitsGrowthYoY.toFixed(1)) : null,
    hasPreviousYearData: prevByDay.size > 0,
    byChannel: [...byChannel.entries()]
      .map(([channel, revenue]) => ({ channel, revenue: Number(revenue.toFixed(2)) }))
      .sort((a, b) => b.revenue - a.revenue),
    byFulfillment: [...byFulfillment.entries()]
      .map(([channel, units]) => ({ channel, units }))
      .sort((a, b) => b.units - a.units),
    byDay: formattedByDay,
    byWeek: formattedByWeek,
    topProducts: [...byProduct.entries()]
      .map(([sku, data]) => ({ sku, ...data, revenue: Number(data.revenue.toFixed(2)) }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10),
  };
}
