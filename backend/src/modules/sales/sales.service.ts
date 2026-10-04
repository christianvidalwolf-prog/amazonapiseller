import fs from "node:fs";
import path from "node:path";
import type { SpApiClient } from "../../spapi/client";
import { createReport, downloadReportDocument, getReport, getReportDocument } from "../../spapi/endpoints/reports";
import { sleep } from "../../spapi/rateLimiter";

const REPORT_TYPE = "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL";
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40;

export const RETURN_REASON_LABELS: Record<string, string> = {
  DAMAGED_BY_FC: "Dañado por centro logístico",
  NOT_COMPATIBLE: "Incompatible / No encaja",
  UNWANTED_ITEM: "No deseado / Cambio de opinión",
  QUALITY_UNACCEPTABLE: "Calidad no aceptable",
  DEFECTIVE: "Defectuoso / Averiado",
  NOT_AS_DESCRIBED: "No coincide con la descripción",
  DAMAGED_BY_CARRIER: "Dañado durante transporte",
  NO_REASON_GIVEN: "Sin motivo especificado",
  APPAREL_TOO_SMALL: "Demasiado pequeño",
  APPAREL_TOO_LARGE: "Demasiado grande",
  FOUND_BETTER_PRICE: "Mejor precio en otro sitio",
  MISORDERED: "Pedido por error",
  EXTRA_ITEM: "Artículo extra",
  SWITCHEROO: "Artículo incorrecto devuelto",
  NEVER_ARRIVED: "No llegó a tiempo",
  CUSTOMER_DAMAGED: "Dañado por cliente",
};

export function getReturnReasonLabel(reason: string): string {
  if (!reason) return "Sin motivo especificado";
  return RETURN_REASON_LABELS[reason] || reason.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

export interface ReturnReasonSummary {
  reason: string;
  label: string;
  count: number;
  units: number;
  revenue: number;
}

export interface DailySalesRecord {
  date: string; // "YYYY-MM-DD"
  revenue: number;
  returnedRevenue: number;
  netRevenue: number;
  units: number;
  returnedUnits: number;
  netUnits: number;
  returnRatePct: number | null;
  // Year-over-year same calendar day comparison
  prevYearDate: string; // "YYYY-1-MM-DD"
  prevYearRevenue: number;
  prevYearReturnedRevenue: number;
  prevYearNetRevenue: number;
  prevYearUnits: number;
  prevYearReturnedUnits: number;
  prevYearNetUnits: number;
  revenueDiff: number; // revenue - prevYearRevenue
  revenueGrowthPct: number | null; // ((revenue - prevYearRevenue) / prevYearRevenue) * 100
  unitsDiff: number;
  unitsGrowthPct: number | null;
}

export interface WeeklySalesRecord {
  weekStart: string;
  weekEnd: string;
  revenue: number;
  returnedRevenue: number;
  netRevenue: number;
  units: number;
  returnedUnits: number;
  netUnits: number;
  orders: number;
  returnsCount: number;
  prevYearRevenue: number;
  prevYearReturnedRevenue: number;
  prevYearNetRevenue: number;
  prevYearUnits: number;
  prevYearReturnedUnits: number;
  prevYearNetUnits: number;
  revenueGrowthPct: number | null;
}

export interface SalesSummary {
  totalRevenue: number;
  returnedRevenue: number;
  netRevenue: number;
  productRevenue: number;
  shippingRevenue: number;
  productTax: number;
  shippingTax: number;
  promotions: number;
  customerReimbursements: number;
  totalUnits: number;
  returnedUnits: number;
  netUnits: number;
  returnRateUnits: number | null;
  returnRateRevenue: number | null;
  uniqueOrders: number;
  orderLines: number;
  returnsCount: number;
  // YoY comparison metrics
  prevYearTotalRevenue: number;
  prevYearReturnedRevenue: number;
  prevYearNetRevenue: number;
  prevYearTotalUnits: number;
  prevYearReturnedUnits: number;
  prevYearNetUnits: number;
  revenueGrowthYoY: number | null;
  unitsGrowthYoY: number | null;
  hasPreviousYearData: boolean;

  byChannel: Array<{ channel: string; revenue: number; returnedRevenue: number; netRevenue: number }>;
  byFulfillment: Array<{ channel: string; units: number }>;
  byDay: DailySalesRecord[];
  byWeek: WeeklySalesRecord[];
  topProducts: Array<{
    sku: string;
    name: string;
    units: number;
    returnedUnits: number;
    netUnits: number;
    revenue: number;
    returnedRevenue: number;
    netRevenue: number;
    returnRatePct: number | null;
  }>;
  returnsByReason: ReturnReasonSummary[];
}

export const GLOBAL_CHANNEL = "ALL";
export const AMAZON_GLOBAL_CHANNEL = "AMAZON_ALL";

export function isAmazonChannel(channel: string): boolean {
  return channel.startsWith("Amazon") || channel.startsWith("Non-Amazon");
}

export interface SalesReport {
  /** Sales-channel values found in the data (e.g. "Amazon.es", "Amazon.de"), sorted. */
  availableChannels: string[];
  /** Keyed by channel name, plus GLOBAL_CHANNEL for every country combined and AMAZON_GLOBAL_CHANNEL for all Amazon channels combined. */
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

export interface PeriodProductDetail {
  sku: string;
  asin: string;
  name: string;
  units: number;
  returnedUnits: number;
  netUnits: number;
  revenue: number;
  returnedRevenue: number;
  netRevenue: number;
  returnRatePct: number | null;
  avgPrice: number;
  orderCount: number;
}

export interface PeriodOrderItemDetail {
  sku: string;
  asin: string;
  name: string;
  quantity: number;
  itemPrice: number;
  itemTax: number;
  shippingPrice: number;
  totalPrice: number;
}

export interface PeriodOrderDetail {
  orderId: string;
  purchaseDate: string;
  orderStatus: string;
  salesChannel: string;
  fulfillmentChannel: string;
  shipCity: string;
  shipState: string;
  shipPostalCode: string;
  shipCountry: string;
  isPrime: boolean;
  isBusinessOrder: boolean;
  currency: string;
  totalUnits: number;
  totalRevenue: number;
  items: PeriodOrderItemDetail[];
}

export interface PeriodReturnDetail {
  returnDate: string;
  orderId: string;
  sku: string;
  asin: string;
  name: string;
  quantity: number;
  refundAmount: number;
  reason: string;
  reasonLabel: string;
  detailedDisposition: string;
  status: string;
  customerComments: string;
  fulfillmentCenterId: string;
  licensePlateNumber: string;
  salesChannel: string;
}

export interface PeriodSalesDetailResult {
  start: string;
  end: string;
  channel: string;
  metrics: {
    totalRevenue: number;
    returnedRevenue: number;
    netRevenue: number;
    totalUnits: number;
    returnedUnits: number;
    netUnits: number;
    totalOrders: number;
    totalReturns: number;
    avgOrderValue: number;
    returnRatePct: number | null;
  };
  products: PeriodProductDetail[];
  orders: PeriodOrderDetail[];
  returns: PeriodReturnDetail[];
}

interface OrderLookupInfo {
  unitPrice: number;
  channel: string;
}

export class SalesService {
  constructor(private readonly client: SpApiClient, private readonly marketplaceIds: string[]) {}

  /**
   * Requests or loads order data for current period and matching prior-year window,
   * returning consolidated metrics with day-by-day YoY comparisons.
   */
  async getSalesSummary(dataStartTime: string, dataEndTime: string): Promise<SalesSummary> {
    const { currentRows, currentReturns, prevYearRows, prevYearReturns, orderLookup } =
      await this.loadRowsWithHistory(dataStartTime, dataEndTime);
    return aggregate(currentRows, currentReturns, prevYearRows, prevYearReturns, orderLookup);
  }

  /**
   * Same underlying row fetch as getSalesSummary, but aggregated once per
   * sales channel (country) plus once for every channel combined (GLOBAL_CHANNEL).
   */
  async getSalesReport(dataStartTime: string, dataEndTime: string): Promise<SalesReport> {
    const { currentRows, currentReturns, prevYearRows, prevYearReturns, orderLookup } =
      await this.loadRowsWithHistory(dataStartTime, dataEndTime);

    const availableChannels = [...new Set(currentRows.map((row) => row["sales-channel"] || "Desconocido"))].sort();

    const summaries: Record<string, SalesSummary> = {
      [GLOBAL_CHANNEL]: aggregate(currentRows, currentReturns, prevYearRows, prevYearReturns, orderLookup),
      [AMAZON_GLOBAL_CHANNEL]: aggregate(
        currentRows.filter((row) => isAmazonChannel(row["sales-channel"] || "")),
        currentReturns.filter((ret) => {
          const key = `${ret["order-id"]}|${ret["sku"]}`;
          const info = orderLookup.get(key) || orderLookup.get(ret["order-id"] ?? "");
          return isAmazonChannel(info?.channel || "");
        }),
        prevYearRows.filter((row) => isAmazonChannel(row["sales-channel"] || "")),
        prevYearReturns.filter((ret) => {
          const key = `${ret["order-id"]}|${ret["sku"]}`;
          const info = orderLookup.get(key) || orderLookup.get(ret["order-id"] ?? "");
          return isAmazonChannel(info?.channel || "");
        }),
        orderLookup
      ),
    };

    for (const ch of availableChannels) {
      const matchReturnChannel = (ret: Record<string, string>) => {
        const key = `${ret["order-id"]}|${ret["sku"]}`;
        const info = orderLookup.get(key) || orderLookup.get(ret["order-id"] ?? "");
        return (info?.channel || "Desconocido") === ch;
      };

      summaries[ch] = aggregate(
        currentRows.filter((row) => (row["sales-channel"] || "Desconocido") === ch),
        currentReturns.filter(matchReturnChannel),
        prevYearRows.filter((row) => (row["sales-channel"] || "Desconocido") === ch),
        prevYearReturns.filter(matchReturnChannel),
        orderLookup
      );
    }

    return { availableChannels, summaries };
  }

  /**
   * Returns itemized details (all products sold and individual orders) for a specific day or week.
   */
  async getPeriodDetails(
    start: string,
    end: string,
    channel: string = GLOBAL_CHANNEL
  ): Promise<PeriodSalesDetailResult> {
    const normalizedStart = start.length === 10 ? `${start}T00:00:00.000Z` : start;
    const normalizedEnd = end.length === 10 ? `${end}T23:59:59.999Z` : end;

    const preferredCsv = normalizedStart.startsWith("2025") ? "ventas_2025.csv" : "ventas_2026.csv";
    const preferredReturnsCsv = normalizedStart.startsWith("2025") ? "devoluciones_2025.csv" : "devoluciones_2026.csv";

    const rawRows = await this.loadRows(normalizedStart, normalizedEnd, preferredCsv);
    const rawReturns = await this.loadReturnsRows(normalizedStart, normalizedEnd, preferredReturnsCsv);

    // Build order lookup for returns
    const orderLookup = new Map<string, OrderLookupInfo>();
    for (const row of rawRows) {
      const orderId = row["amazon-order-id"] ?? "";
      const sku = row["sku"] ?? "";
      const price = Number.parseFloat((row["item-price"] ?? "0").replace(",", ".")) || 0;
      const quantity = Number.parseInt(row["quantity"] ?? "1", 10) || 1;
      const ch = row["sales-channel"] || "Desconocido";
      const info: OrderLookupInfo = { unitPrice: price / quantity, channel: ch };
      if (orderId && sku) orderLookup.set(`${orderId}|${sku}`, info);
      if (orderId && !orderLookup.has(orderId)) orderLookup.set(orderId, info);
    }

    const validRows = rawRows.filter((row) => {
      const status = (row["order-status"] ?? "").toLowerCase();
      if (status === "cancelled") return false;
      const date = row["purchase-date"] ?? "";
      if (date && (date < normalizedStart || date > normalizedEnd)) return false;
      if (channel && channel !== GLOBAL_CHANNEL) {
        if (channel === AMAZON_GLOBAL_CHANNEL) {
          if (!isAmazonChannel(row["sales-channel"] || "")) return false;
        } else if ((row["sales-channel"] || "Desconocido") !== channel) {
          return false;
        }
      }
      return true;
    });

    const productsMap = new Map<
      string,
      {
        sku: string;
        asin: string;
        name: string;
        units: number;
        returnedUnits: number;
        revenue: number;
        returnedRevenue: number;
        orders: Set<string>;
      }
    >();

    const ordersMap = new Map<string, PeriodOrderDetail>();
    let totalRevenue = 0;
    let totalUnits = 0;

    for (const row of validRows) {
      const orderId = row["amazon-order-id"] ?? "Desconocido";
      const quantity = Number.parseInt(row["quantity"] ?? "1", 10) || 1;
      const price = Number.parseFloat((row["item-price"] ?? "0").replace(",", ".")) || 0;
      const tax = Number.parseFloat((row["item-tax"] ?? "0").replace(",", ".")) || 0;
      const shipping = Number.parseFloat((row["shipping-price"] ?? "0").replace(",", ".")) || 0;
      const sku = row["sku"] || "Sin SKU";
      const asin = row["asin"] || "";
      const name = row["product-name"] || sku;

      totalUnits += quantity;
      totalRevenue += price;

      // Product grouping
      const prod = productsMap.get(sku) ?? {
        sku,
        asin,
        name,
        units: 0,
        returnedUnits: 0,
        revenue: 0,
        returnedRevenue: 0,
        orders: new Set<string>(),
      };
      prod.units += quantity;
      prod.revenue += price;
      if (orderId) prod.orders.add(orderId);
      productsMap.set(sku, prod);

      // Order item
      const itemDetail: PeriodOrderItemDetail = {
        sku,
        asin,
        name,
        quantity,
        itemPrice: Number(price.toFixed(2)),
        itemTax: Number(tax.toFixed(2)),
        shippingPrice: Number(shipping.toFixed(2)),
        totalPrice: Number((price + shipping).toFixed(2)),
      };

      // Order grouping
      const existingOrder = ordersMap.get(orderId);
      if (existingOrder) {
        existingOrder.totalUnits += quantity;
        existingOrder.totalRevenue = Number((existingOrder.totalRevenue + price).toFixed(2));
        existingOrder.items.push(itemDetail);
      } else {
        ordersMap.set(orderId, {
          orderId,
          purchaseDate: row["purchase-date"] ?? "",
          orderStatus: row["order-status"] ?? "Unknown",
          salesChannel: row["sales-channel"] ?? "Desconocido",
          fulfillmentChannel:
            (row["fulfillment-channel"] ?? "").toLowerCase().includes("amazon") ||
            (row["fulfillment-channel"] ?? "").toLowerCase().includes("afn")
              ? "FBA"
              : "FBM",
          shipCity: row["ship-city"] ?? "",
          shipState: row["ship-state"] ?? "",
          shipPostalCode: row["ship-postal-code"] ?? "",
          shipCountry: row["ship-country"] ?? "",
          isPrime: row["is-prime"] === "True" || row["is-prime"] === "true",
          isBusinessOrder: row["is-business-order"] === "True" || row["is-business-order"] === "true",
          currency: row["currency"] || "EUR",
          totalUnits: quantity,
          totalRevenue: Number(price.toFixed(2)),
          items: [itemDetail],
        });
      }
    }

    // Process returns in period
    const periodReturns: PeriodReturnDetail[] = [];
    let returnedRevenue = 0;
    let returnedUnits = 0;

    for (const ret of rawReturns) {
      const returnDate = ret["return-date"] ?? "";
      if (returnDate && (returnDate < normalizedStart || returnDate > normalizedEnd)) continue;

      const orderId = ret["order-id"] ?? "";
      const sku = ret["sku"] ?? "";
      const key = `${orderId}|${sku}`;
      const lookup = orderLookup.get(key) || orderLookup.get(orderId);
      const retChannel = lookup?.channel || "Desconocido";

      if (channel && channel !== GLOBAL_CHANNEL) {
        if (channel === AMAZON_GLOBAL_CHANNEL) {
          if (!isAmazonChannel(retChannel)) continue;
        } else if (retChannel !== channel) {
          continue;
        }
      }

      const quantity = Number.parseInt(ret["quantity"] ?? "1", 10) || 1;
      const unitPrice = lookup?.unitPrice ?? 0;
      const refundAmount = Number((unitPrice * quantity).toFixed(2));

      returnedUnits += quantity;
      returnedRevenue += refundAmount;

      const reason = ret["reason"] || "NO_REASON_GIVEN";
      const item: PeriodReturnDetail = {
        returnDate,
        orderId,
        sku,
        asin: ret["asin"] || "",
        name: ret["product-name"] || sku,
        quantity,
        refundAmount,
        reason,
        reasonLabel: getReturnReasonLabel(reason),
        detailedDisposition: ret["detailed-disposition"] || "",
        status: ret["status"] || "",
        customerComments: ret["customer-comments"] || "",
        fulfillmentCenterId: ret["fulfillment-center-id"] || "",
        licensePlateNumber: ret["license-plate-number"] || "",
        salesChannel: retChannel,
      };
      periodReturns.push(item);

      // Add to product metrics
      const prod = productsMap.get(sku);
      if (prod) {
        prod.returnedUnits += quantity;
        prod.returnedRevenue += refundAmount;
      }
    }

    periodReturns.sort((a, b) => b.returnDate.localeCompare(a.returnDate));

    const products: PeriodProductDetail[] = [...productsMap.values()]
      .map((p) => {
        const netUnits = p.units - p.returnedUnits;
        const netRevenue = Number((p.revenue - p.returnedRevenue).toFixed(2));
        const returnRatePct = p.units > 0 ? Number(((p.returnedUnits / p.units) * 100).toFixed(1)) : 0;
        return {
          sku: p.sku,
          asin: p.asin,
          name: p.name,
          units: p.units,
          returnedUnits: p.returnedUnits,
          netUnits,
          revenue: Number(p.revenue.toFixed(2)),
          returnedRevenue: Number(p.returnedRevenue.toFixed(2)),
          netRevenue,
          returnRatePct,
          avgPrice: p.units > 0 ? Number((p.revenue / p.units).toFixed(2)) : 0,
          orderCount: p.orders.size,
        };
      })
      .sort((a, b) => b.revenue - a.revenue);

    const orders: PeriodOrderDetail[] = [...ordersMap.values()].sort((a, b) =>
      b.purchaseDate.localeCompare(a.purchaseDate)
    );

    const totalOrders = orders.length;
    const netRevenue = Number((totalRevenue - returnedRevenue).toFixed(2));
    const netUnits = totalUnits - returnedUnits;
    const returnRatePct = totalUnits > 0 ? Number(((returnedUnits / totalUnits) * 100).toFixed(1)) : null;

    return {
      start: normalizedStart,
      end: normalizedEnd,
      channel,
      metrics: {
        totalRevenue: Number(totalRevenue.toFixed(2)),
        returnedRevenue: Number(returnedRevenue.toFixed(2)),
        netRevenue,
        totalUnits,
        returnedUnits,
        netUnits,
        totalOrders,
        totalReturns: periodReturns.length,
        avgOrderValue: totalOrders > 0 ? Number((totalRevenue / totalOrders).toFixed(2)) : 0,
        returnRatePct,
      },
      products,
      orders,
      returns: periodReturns,
    };
  }

  private async loadRowsWithHistory(
    dataStartTime: string,
    dataEndTime: string
  ): Promise<{
    currentRows: Record<string, string>[];
    currentReturns: Record<string, string>[];
    prevYearRows: Record<string, string>[];
    prevYearReturns: Record<string, string>[];
    orderLookup: Map<string, OrderLookupInfo>;
  }> {
    const currentRows = await this.loadRows(dataStartTime, dataEndTime, "ventas_2026.csv");
    const currentReturns = await this.loadReturnsRows(dataStartTime, dataEndTime, "devoluciones_2026.csv");

    const prevStart = shiftOneYearBack(dataStartTime);
    const prevEnd = shiftOneYearBack(dataEndTime);
    const prevYearRows = await this.loadRows(prevStart, prevEnd, "ventas_2025.csv");
    const prevYearReturns = await this.loadReturnsRows(prevStart, prevEnd, "devoluciones_2025.csv");

    // Index all orders from both periods and full year files for accurate return pricing and channel
    const orderLookup = new Map<string, OrderLookupInfo>();

    const indexRows = (rows: Record<string, string>[]) => {
      for (const row of rows) {
        const orderId = row["amazon-order-id"] ?? "";
        const sku = row["sku"] ?? "";
        const parseMoney = (k: string) => Number.parseFloat((row[k] ?? "0").replace(",", ".")) || 0;
        const price = parseMoney("item-price");
        const quantity = Number.parseInt(row["quantity"] ?? "1", 10) || 1;
        const channel = row["sales-channel"] || "Desconocido";
        const unitPrice = quantity > 0 ? price / quantity : price;
        const info: OrderLookupInfo = { unitPrice, channel };
        if (orderId && sku) orderLookup.set(`${orderId}|${sku}`, info);
        if (orderId && !orderLookup.has(orderId)) orderLookup.set(orderId, info);
      }
    };

    indexRows(prevYearRows);
    indexRows(currentRows);

    return { currentRows, currentReturns, prevYearRows, prevYearReturns, orderLookup };
  }

  private async loadReturnsRows(
    dataStartTime: string,
    dataEndTime: string,
    preferredCsvFilename = "devoluciones_2026.csv"
  ): Promise<Record<string, string>[]> {
    const csvPath = path.resolve(process.cwd(), "..", preferredCsvFilename);
    const altCsvPath = path.resolve(process.cwd(), preferredCsvFilename);
    const targetPath = fs.existsSync(csvPath) ? csvPath : fs.existsSync(altCsvPath) ? altCsvPath : null;

    if (targetPath) {
      try {
        const text = fs.readFileSync(targetPath, "utf-8");
        const rows = parseTabDelimited(text);
        if (rows.length > 0) {
          const filtered = rows.filter((r) => {
            const date = r["return-date"] ?? "";
            if (!date) return false;
            if (dataStartTime && date < dataStartTime) return false;
            if (dataEndTime && date > dataEndTime) return false;
            return true;
          });
          return dataStartTime || dataEndTime ? filtered : rows;
        }
      } catch (err) {
        console.warn(`No se pudo leer ${preferredCsvFilename} local:`, err);
      }
    }
    return [];
  }

  private readCsvFiles(filenames: string[], dataStartTime: string, dataEndTime: string): Record<string, string>[] {
    const combined: Record<string, string>[] = [];
    for (const filename of filenames) {
      const csvPath = path.resolve(process.cwd(), "..", filename);
      const altCsvPath = path.resolve(process.cwd(), filename);
      const targetPath = fs.existsSync(csvPath) ? csvPath : fs.existsSync(altCsvPath) ? altCsvPath : null;

      if (!targetPath) continue;
      try {
        const text = fs.readFileSync(targetPath, "utf-8");
        const rows = parseCsvSemicolon(text);
        if (rows.length > 0) {
          const filtered = rows.filter((r) => {
            const date = r["purchase-date"] ?? "";
            if (!date) return false;
            if (dataStartTime && date < dataStartTime) return false;
            if (dataEndTime && date > dataEndTime) return false;
            return true;
          });
          combined.push(...(dataStartTime || dataEndTime ? filtered : rows));
        }
      } catch (err) {
        console.warn(`No se pudo leer ${filename} local:`, err);
      }
    }
    return combined;
  }

  private async loadRows(
    dataStartTime: string,
    dataEndTime: string,
    preferredCsvFilename = "ventas_2026.csv"
  ): Promise<Record<string, string>[]> {
    // Determine all relevant files for the period (Amazon + PrestaShop + Cdiscount)
    const is2025 = preferredCsvFilename.includes("2025") || (dataStartTime && dataStartTime.startsWith("2025"));
    const filesToLoad = is2025
      ? ["ventas_2025.csv", "ventas_prestashop_2025.csv", "ventas_cdiscount_2025.csv"]
      : ["ventas_2026.csv", "ventas_prestashop_2026.csv", "ventas_cdiscount_2026.csv"];

    const localRows = this.readCsvFiles(filesToLoad, dataStartTime, dataEndTime);
    if (localRows.length > 0) {
      return localRows;
    }

    // Si es 2025 y no hay CSV, no llamamos a SP-API de forma síncrona en cada petición para no bloquear
    if (is2025) {
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

function aggregate(
  rows: Record<string, string>[],
  returnRows: Record<string, string>[] = [],
  prevYearRows: Record<string, string>[] = [],
  prevYearReturnRows: Record<string, string>[] = [],
  orderLookup: Map<string, OrderLookupInfo> = new Map()
): SalesSummary {
  const validRows = rows.filter((row) => (row["order-status"] ?? "").toLowerCase() !== "cancelled");
  const validPrevRows = prevYearRows.filter((row) => (row["order-status"] ?? "").toLowerCase() !== "cancelled");

  // Previous year lookup maps by day and week
  const prevByDay = new Map<string, { revenue: number; returnedRevenue: number; units: number; returnedUnits: number }>();
  const prevByWeek = new Map<string, { revenue: number; returnedRevenue: number; units: number; returnedUnits: number }>();
  let prevYearTotalRevenue = 0;
  let prevYearTotalUnits = 0;
  let prevYearReturnedRevenue = 0;
  let prevYearReturnedUnits = 0;

  for (const row of validPrevRows) {
    const quantity = Number.parseInt(row["quantity"] ?? "1", 10) || 1;
    const parseMoney = (key: string) => Number.parseFloat((row[key] ?? "0").replace(",", ".")) || 0;
    const price = parseMoney("item-price");
    const fullRevenue = price + parseMoney("shipping-price") + parseMoney("item-tax") + parseMoney("shipping-tax") + parseMoney("item-promotion-discount") + parseMoney("ship-promotion-discount") + parseMoney("gift-wrap-price") + parseMoney("gift-wrap-tax");
    prevYearTotalRevenue += fullRevenue;
    prevYearTotalUnits += quantity;

    const day = (row["purchase-date"] ?? "").slice(0, 10);
    if (day) {
      const entry = prevByDay.get(day) ?? { revenue: 0, returnedRevenue: 0, units: 0, returnedUnits: 0 };
      entry.revenue += fullRevenue;
      entry.units += quantity;
      prevByDay.set(day, entry);

      const weekStart = weekStartOf(day);
      const wEntry = prevByWeek.get(weekStart) ?? { revenue: 0, returnedRevenue: 0, units: 0, returnedUnits: 0 };
      wEntry.revenue += fullRevenue;
      wEntry.units += quantity;
      prevByWeek.set(weekStart, wEntry);
    }
  }

  // Process prev year returns
  for (const ret of prevYearReturnRows) {
    const quantity = Number.parseInt(ret["quantity"] ?? "1", 10) || 1;
    const orderId = ret["order-id"] ?? "";
    const sku = ret["sku"] ?? "";
    const lookup = orderLookup.get(`${orderId}|${sku}`) || orderLookup.get(orderId);
    const refund = Number(((lookup?.unitPrice ?? 0) * quantity).toFixed(2));

    prevYearReturnedRevenue += refund;
    prevYearReturnedUnits += quantity;

    const day = (ret["return-date"] ?? "").slice(0, 10);
    if (day) {
      const entry = prevByDay.get(day) ?? { revenue: 0, returnedRevenue: 0, units: 0, returnedUnits: 0 };
      entry.returnedRevenue += refund;
      entry.returnedUnits += quantity;
      prevByDay.set(day, entry);

      const weekStart = weekStartOf(day);
      const wEntry = prevByWeek.get(weekStart) ?? { revenue: 0, returnedRevenue: 0, units: 0, returnedUnits: 0 };
      wEntry.returnedRevenue += refund;
      wEntry.returnedUnits += quantity;
      prevByWeek.set(weekStart, wEntry);
    }
  }

  const orderIds = new Set<string>();
  const byChannel = new Map<string, { revenue: number; returnedRevenue: number }>();
  const byFulfillment = new Map<string, number>();
  const byDay = new Map<string, { revenue: number; returnedRevenue: number; units: number; returnedUnits: number }>();
  const byWeek = new Map<string, { revenue: number; returnedRevenue: number; units: number; returnedUnits: number; orders: Set<string>; returnsCount: number }>();
  const byProduct = new Map<string, { name: string; units: number; returnedUnits: number; revenue: number; returnedRevenue: number }>();
  const byReason = new Map<string, { count: number; units: number; revenue: number }>();

  let totalRevenue = 0;
  let returnedRevenue = 0;
  let productRevenue = 0;
  let shippingRevenue = 0;
  let productTax = 0;
  let shippingTax = 0;
  let promotions = 0;
  let customerReimbursements = 0;
  let totalUnits = 0;
  let returnedUnits = 0;

  for (const row of validRows) {
    const orderId = row["amazon-order-id"] ?? "";
    if (orderId) orderIds.add(orderId);

    const quantity = Number.parseInt(row["quantity"] ?? "1", 10) || 1;
    totalUnits += quantity;

    const parseMoney = (key: string) => Number.parseFloat((row[key] ?? "0").replace(",", ".")) || 0;
    const price = parseMoney("item-price");
    const shipping = parseMoney("shipping-price");
    const itemTax = parseMoney("item-tax");
    const shipTax = parseMoney("shipping-tax");
    const promotion = parseMoney("item-promotion-discount") + parseMoney("ship-promotion-discount");
    const reimbursements = parseMoney("gift-wrap-price") + parseMoney("gift-wrap-tax");
    const fullRevenue = price + shipping + itemTax + shipTax + promotion + reimbursements;
    productRevenue += price;
    shippingRevenue += shipping;
    productTax += itemTax;
    shippingTax += shipTax;
    promotions += promotion;
    customerReimbursements += reimbursements;
    totalRevenue += fullRevenue;

    const channel = row["sales-channel"] || "Desconocido";
    const chEntry = byChannel.get(channel) ?? { revenue: 0, returnedRevenue: 0 };
    chEntry.revenue += fullRevenue;
    byChannel.set(channel, chEntry);

    const fulfillment = row["fulfillment-channel"] || "Desconocido";
    byFulfillment.set(fulfillment, (byFulfillment.get(fulfillment) ?? 0) + quantity);

    const day = (row["purchase-date"] ?? "").slice(0, 10);
    if (day) {
      const dayEntry = byDay.get(day) ?? { revenue: 0, returnedRevenue: 0, units: 0, returnedUnits: 0 };
      dayEntry.revenue += fullRevenue;
      dayEntry.units += quantity;
      byDay.set(day, dayEntry);

      const weekStart = weekStartOf(day);
      const weekEntry = byWeek.get(weekStart) ?? { revenue: 0, returnedRevenue: 0, units: 0, returnedUnits: 0, orders: new Set<string>(), returnsCount: 0 };
      weekEntry.revenue += fullRevenue;
      weekEntry.units += quantity;
      if (orderId) weekEntry.orders.add(orderId);
      byWeek.set(weekStart, weekEntry);
    }

    const sku = row["sku"] || "Sin SKU";
    const name = (row["product-name"] ?? "").slice(0, 80);
    const existing = byProduct.get(sku) ?? { name, units: 0, returnedUnits: 0, revenue: 0, returnedRevenue: 0 };
    existing.units += quantity;
    existing.revenue += fullRevenue;
    byProduct.set(sku, existing);
  }

  // Process current period returns
  for (const ret of returnRows) {
    const quantity = Number.parseInt(ret["quantity"] ?? "1", 10) || 1;
    const orderId = ret["order-id"] ?? "";
    const sku = ret["sku"] ?? "";
    const lookup = orderLookup.get(`${orderId}|${sku}`) || orderLookup.get(orderId);
    const refund = Number(((lookup?.unitPrice ?? 0) * quantity).toFixed(2));
    const channel = lookup?.channel || "Desconocido";

    returnedRevenue += refund;
    returnedUnits += quantity;

    const chEntry = byChannel.get(channel) ?? { revenue: 0, returnedRevenue: 0 };
    chEntry.returnedRevenue += refund;
    byChannel.set(channel, chEntry);

    const day = (ret["return-date"] ?? "").slice(0, 10);
    if (day) {
      const dayEntry = byDay.get(day) ?? { revenue: 0, returnedRevenue: 0, units: 0, returnedUnits: 0 };
      dayEntry.returnedRevenue += refund;
      dayEntry.returnedUnits += quantity;
      byDay.set(day, dayEntry);

      const weekStart = weekStartOf(day);
      const weekEntry = byWeek.get(weekStart) ?? { revenue: 0, returnedRevenue: 0, units: 0, returnedUnits: 0, orders: new Set<string>(), returnsCount: 0 };
      weekEntry.returnedRevenue += refund;
      weekEntry.returnedUnits += quantity;
      weekEntry.returnsCount += 1;
      byWeek.set(weekStart, weekEntry);
    }

    if (sku) {
      const prod = byProduct.get(sku) ?? { name: ret["product-name"] || sku, units: 0, returnedUnits: 0, revenue: 0, returnedRevenue: 0 };
      prod.returnedUnits += quantity;
      prod.returnedRevenue += refund;
      byProduct.set(sku, prod);
    }

    const reason = ret["reason"] || "NO_REASON_GIVEN";
    const rEntry = byReason.get(reason) ?? { count: 0, units: 0, revenue: 0 };
    rEntry.count += 1;
    rEntry.units += quantity;
    rEntry.revenue += refund;
    byReason.set(reason, rEntry);
  }

  // Format daily records with YoY same-calendar-day comparisons
  const formattedByDay: DailySalesRecord[] = [...byDay.entries()]
    .map(([date, data]) => {
      const prevYearDate = shiftOneYearBack(date);
      const prev = prevByDay.get(prevYearDate) ?? { revenue: 0, returnedRevenue: 0, units: 0, returnedUnits: 0 };
      const netRevenue = Number((data.revenue - data.returnedRevenue).toFixed(2));
      const prevYearNetRevenue = Number((prev.revenue - prev.returnedRevenue).toFixed(2));
      const revenueDiff = netRevenue - prevYearNetRevenue;
      const revenueGrowthPct = prevYearNetRevenue > 0 ? ((netRevenue - prevYearNetRevenue) / prevYearNetRevenue) * 100 : null;
      const netUnits = data.units - data.returnedUnits;
      const prevYearNetUnits = prev.units - prev.returnedUnits;
      const unitsDiff = netUnits - prevYearNetUnits;
      const unitsGrowthPct = prevYearNetUnits > 0 ? ((netUnits - prevYearNetUnits) / prevYearNetUnits) * 100 : null;
      const returnRatePct = data.units > 0 ? Number(((data.returnedUnits / data.units) * 100).toFixed(1)) : 0;

      return {
        date,
        revenue: Number(data.revenue.toFixed(2)),
        returnedRevenue: Number(data.returnedRevenue.toFixed(2)),
        netRevenue,
        units: data.units,
        returnedUnits: data.returnedUnits,
        netUnits,
        returnRatePct,
        prevYearDate,
        prevYearRevenue: Number(prev.revenue.toFixed(2)),
        prevYearReturnedRevenue: Number(prev.returnedRevenue.toFixed(2)),
        prevYearNetRevenue,
        prevYearUnits: prev.units,
        prevYearReturnedUnits: prev.returnedUnits,
        prevYearNetUnits,
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
      // 52 weeks back keeps the Monday alignment
      const prevWeekStart = addDays(weekStart, -364);
      const prev = prevByWeek.get(prevWeekStart) ?? { revenue: 0, returnedRevenue: 0, units: 0, returnedUnits: 0 };
      const netRevenue = Number((data.revenue - data.returnedRevenue).toFixed(2));
      const prevYearNetRevenue = Number((prev.revenue - prev.returnedRevenue).toFixed(2));
      const revenueGrowthPct = prevYearNetRevenue > 0 ? ((netRevenue - prevYearNetRevenue) / prevYearNetRevenue) * 100 : null;

      return {
        weekStart,
        weekEnd: addDays(weekStart, 6),
        revenue: Number(data.revenue.toFixed(2)),
        returnedRevenue: Number(data.returnedRevenue.toFixed(2)),
        netRevenue,
        units: data.units,
        returnedUnits: data.returnedUnits,
        netUnits: data.units - data.returnedUnits,
        orders: data.orders.size,
        returnsCount: data.returnsCount,
        prevYearRevenue: Number(prev.revenue.toFixed(2)),
        prevYearReturnedRevenue: Number(prev.returnedRevenue.toFixed(2)),
        prevYearNetRevenue,
        prevYearUnits: prev.units,
        prevYearReturnedUnits: prev.returnedUnits,
        prevYearNetUnits: prev.units - prev.returnedUnits,
        revenueGrowthPct: revenueGrowthPct !== null ? Number(revenueGrowthPct.toFixed(1)) : null,
      };
    })
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  const netRevenue = Number((totalRevenue - returnedRevenue).toFixed(2));
  const netUnits = totalUnits - returnedUnits;
  const prevYearNetRevenue = Number((prevYearTotalRevenue - prevYearReturnedRevenue).toFixed(2));
  const prevYearNetUnits = prevYearTotalUnits - prevYearReturnedUnits;

  const revenueGrowthYoY =
    prevYearNetRevenue > 0 ? ((netRevenue - prevYearNetRevenue) / prevYearNetRevenue) * 100 : null;
  const unitsGrowthYoY =
    prevYearNetUnits > 0 ? ((netUnits - prevYearNetUnits) / prevYearNetUnits) * 100 : null;
  const returnRateUnits = totalUnits > 0 ? Number(((returnedUnits / totalUnits) * 100).toFixed(1)) : null;
  const returnRateRevenue = totalRevenue > 0 ? Number(((returnedRevenue / totalRevenue) * 100).toFixed(1)) : null;

  const returnsByReason: ReturnReasonSummary[] = [...byReason.entries()]
    .map(([reason, d]) => ({
      reason,
      label: getReturnReasonLabel(reason),
      count: d.count,
      units: d.units,
      revenue: Number(d.revenue.toFixed(2)),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    totalRevenue: Number(totalRevenue.toFixed(2)),
    returnedRevenue: Number(returnedRevenue.toFixed(2)),
    netRevenue,
    productRevenue: Number(productRevenue.toFixed(2)),
    shippingRevenue: Number(shippingRevenue.toFixed(2)),
    productTax: Number(productTax.toFixed(2)),
    shippingTax: Number(shippingTax.toFixed(2)),
    promotions: Number(promotions.toFixed(2)),
    customerReimbursements: Number(customerReimbursements.toFixed(2)),
    totalUnits,
    returnedUnits,
    netUnits,
    returnRateUnits,
    returnRateRevenue,
    uniqueOrders: orderIds.size,
    orderLines: validRows.length,
    returnsCount: returnRows.length,
    prevYearTotalRevenue: Number(prevYearTotalRevenue.toFixed(2)),
    prevYearReturnedRevenue: Number(prevYearReturnedRevenue.toFixed(2)),
    prevYearNetRevenue,
    prevYearTotalUnits,
    prevYearReturnedUnits,
    prevYearNetUnits,
    revenueGrowthYoY: revenueGrowthYoY !== null ? Number(revenueGrowthYoY.toFixed(1)) : null,
    unitsGrowthYoY: unitsGrowthYoY !== null ? Number(unitsGrowthYoY.toFixed(1)) : null,
    hasPreviousYearData: prevByDay.size > 0,
    byChannel: [...byChannel.entries()]
      .map(([channel, d]) => ({
        channel,
        revenue: Number(d.revenue.toFixed(2)),
        returnedRevenue: Number(d.returnedRevenue.toFixed(2)),
        netRevenue: Number((d.revenue - d.returnedRevenue).toFixed(2)),
      }))
      .sort((a, b) => b.revenue - a.revenue),
    byFulfillment: [...byFulfillment.entries()]
      .map(([channel, units]) => ({ channel, units }))
      .sort((a, b) => b.units - a.units),
    byDay: formattedByDay,
    byWeek: formattedByWeek,
    topProducts: [...byProduct.entries()]
      .map(([sku, data]) => {
        const pNetUnits = data.units - data.returnedUnits;
        const pNetRevenue = Number((data.revenue - data.returnedRevenue).toFixed(2));
        const returnRatePct = data.units > 0 ? Number(((data.returnedUnits / data.units) * 100).toFixed(1)) : 0;
        return {
          sku,
          name: data.name,
          units: data.units,
          returnedUnits: data.returnedUnits,
          netUnits: pNetUnits,
          revenue: Number(data.revenue.toFixed(2)),
          returnedRevenue: Number(data.returnedRevenue.toFixed(2)),
          netRevenue: pNetRevenue,
          returnRatePct,
        };
      })
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10),
    returnsByReason,
  };
}

