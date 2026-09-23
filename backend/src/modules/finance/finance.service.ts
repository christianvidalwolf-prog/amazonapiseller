import type { SpApiClient } from "../../spapi/client";
import { listTransactions, type TransactionItem } from "../../spapi/endpoints/finances";
import type { PrismaClient } from "@prisma/client";

export interface FinanceSummary {
  periodStart: string;
  totalNet: number;
  manualExpensesTotal: number;
  operatingProfit: number;
  grossShipments: number;
  totalRefunds: number;
  reimbursements: number;
  serviceFees: number;
  transfers: number;
  otherAdjustments: number;
  byType: Array<{ type: string; label: string; amount: number; count: number }>;
  byBreakdown: Array<{ type: string; breakdown: string; label: string; amount: number; count: number }>;
  transactionCount: number;
  nextToken?: string;
  transactions: Array<{
    id: string;
    transactionType: string;
    status?: string;
    description?: string;
    amount: number;
    currency: string;
    postedDate?: string;
    orderId?: string;
    sku?: string;
    breakdowns: Array<{ type: string; amount: number; currency: string }>;
    relatedIdentifiers: Array<{ name?: string; value?: string }>;
  }>;
  recentTransactions: Array<{
    id: string;
    type: string;
    description: string;
    amount: number;
    currency: string;
    date: string;
    orderId?: string;
  }>;
}

// Caché en memoria para no saturar los rate limits de Amazon
let cachedSummary: FinanceSummary | null = null;
let lastFetchTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

export class FinanceService {
  constructor(private readonly client: SpApiClient, private readonly prisma?: PrismaClient, private readonly sellerId = "default") {}

  async listManualExpenses(period?: string) {
    if (!this.prisma) return [];
    try {
      return await this.prisma.manualExpense.findMany({
        where: { sellerId: this.sellerId, ...(period ? { period: new Date(`${period}-01T00:00:00.000Z`) } : {}) },
        orderBy: [{ period: "desc" }, { createdAt: "desc" }],
      });
    } catch {
      return [];
    }
  }

  async addManualExpense(input: { category: string; description: string; allocationType: string; amount: number; currency?: string; period: string; orderId?: string; sku?: string; quantity?: number; unitAmount?: number }) {
    if (!this.prisma) throw new Error("Database is not configured");
    return this.prisma.manualExpense.create({ data: {
      sellerId: this.sellerId, category: input.category, description: input.description,
      allocationType: input.allocationType, amount: input.amount, currency: input.currency || "EUR",
      period: new Date(`${input.period}-01T00:00:00.000Z`), orderId: input.orderId, sku: input.sku,
      quantity: input.quantity, unitAmount: input.unitAmount,
    } });
  }

  async deleteManualExpense(id: string) {
    if (!this.prisma) throw new Error("Database is not configured");
    return this.prisma.manualExpense.deleteMany({ where: { id, sellerId: this.sellerId } });
  }

  async getAnnualFinanceSummary(year: number, forceRefresh = false) {
    const months: Array<FinanceSummary & { month: number; period: string }> = [];
    for (let month = 0; month < 12; month += 1) {
      const start = new Date(Date.UTC(year, month, 1)).toISOString();
      // Cada mes tiene un rango distinto; no reutilizar el caché global del resumen mensual.
      const summary = await this.getFinanceSummary(start, true);
      months.push({ month: month + 1, period: `${year}-${String(month + 1).padStart(2, "0")}`, ...summary });
    }
    const sum = (key: "totalNet" | "grossShipments" | "manualExpensesTotal" | "operatingProfit" | "serviceFees" | "totalRefunds" | "reimbursements") =>
      months.reduce((total, item) => total + Number(item[key] || 0), 0);
    return {
      year,
      months,
      total: {
        totalNet: Math.round(sum("totalNet") * 100) / 100,
        grossShipments: Math.round(sum("grossShipments") * 100) / 100,
        manualExpensesTotal: Math.round(sum("manualExpensesTotal") * 100) / 100,
        operatingProfit: Math.round(sum("operatingProfit") * 100) / 100,
        serviceFees: Math.round(sum("serviceFees") * 100) / 100,
        totalRefunds: Math.round(sum("totalRefunds") * 100) / 100,
        reimbursements: Math.round(sum("reimbursements") * 100) / 100,
      },
    };
  }

  async getFinanceSummary(postedAfter?: string, forceRefresh = false): Promise<FinanceSummary> {
    const now = Date.now();
    const defaultStart = postedAfter || new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();

    if (!forceRefresh && cachedSummary && now - lastFetchTimestamp < CACHE_TTL_MS) {
      return cachedSummary;
    }

    const transactions: TransactionItem[] = [];
    let nextToken: string | undefined;
    do {
      const response = await listTransactions(this.client, {
        postedAfter: defaultStart,
        nextToken,
      });
      transactions.push(...(response.payload?.transactions || []));
      nextToken = response.payload?.nextToken || response.nextToken;
    } while (nextToken);

    let grossShipments = 0;
    let totalRefunds = 0;
    let reimbursements = 0;
    let serviceFees = 0;
    let transfers = 0;
    let otherAdjustments = 0;
    let totalNet = 0;

    const typeMap = new Map<string, { amount: number; count: number }>();
    const breakdownMap = new Map<string, { type: string; breakdown: string; amount: number; count: number }>();

    for (const t of transactions) {
      const type = t.transactionType || "Other";
      const amt = Number(t.totalAmount?.currencyAmount || 0);

      totalNet += amt;

      const current = typeMap.get(type) || { amount: 0, count: 0 };
      current.amount += amt;
      current.count += 1;
      typeMap.set(type, current);

      for (const breakdown of t.breakdowns || []) {
        const breakdownType = breakdown.breakdownType || "Unknown";
        const key = `${type}:${breakdownType}`;
        const item = breakdownMap.get(key) || { type, breakdown: breakdownType, amount: 0, count: 0 };
        item.amount += Number(breakdown.breakdownAmount?.currencyAmount || 0);
        item.count += 1;
        breakdownMap.set(key, item);
      }

      switch (type) {
        case "Shipment":
          grossShipments += amt;
          break;
        case "Refund":
          totalRefunds += amt;
          break;
        case "FBAInventoryReimbursement":
          reimbursements += amt;
          break;
        case "ServiceFee":
          serviceFees += amt;
          break;
        case "Transfer":
          transfers += amt;
          break;
        default:
          otherAdjustments += amt;
          break;
      }
    }

    const TYPE_LABELS: Record<string, string> = {
      Shipment: "Ventas y Envíos",
      Refund: "Reembolsos y Devoluciones",
      FBAInventoryReimbursement: "Indemnizaciones de Amazon FBA",
      ServiceFee: "Tarifas de Servicio y Suscripción",
      Transfer: "Transferencias a Cuenta Bancaria",
      Retrocharge: "Retrocargos / Ajustes",
      Adjustment: "Ajustes de Saldo",
      RemovalShipment: "Tarifas de Retirada FBA",
    };

    const byType = Array.from(typeMap.entries()).map(([type, data]) => ({
      type,
      label: TYPE_LABELS[type] || type,
      amount: Math.round(data.amount * 100) / 100,
      count: data.count,
    })).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

    const byBreakdown = Array.from(breakdownMap.values()).map((item) => ({
      ...item,
      label: `${TYPE_LABELS[item.type] || item.type} · ${item.breakdown}`,
      amount: Math.round(item.amount * 100) / 100,
    })).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

    const recentTransactions = transactions.slice(0, 50).map((t) => {
      const orderIdObj = t.relatedIdentifiers?.find(
        (id) => id.relatedIdentifierName?.toLowerCase().includes("order")
      );
      return {
        id: t.transactionId,
        type: TYPE_LABELS[t.transactionType] || t.transactionType,
        description: t.description || t.transactionType,
        amount: Number(t.totalAmount?.currencyAmount || 0),
        currency: t.totalAmount?.currencyCode || "EUR",
        date: t.postedDate ? t.postedDate.slice(0, 16).replace("T", " ") : "-",
        orderId: orderIdObj?.relatedIdentifierValue,
      };
    });

    const detailedTransactions = transactions.map((t) => ({
      id: t.transactionId,
      transactionType: t.transactionType || "Other",
      status: t.transactionStatus,
      description: t.description,
      amount: Number(t.totalAmount?.currencyAmount || 0),
      currency: t.totalAmount?.currencyCode || "EUR",
      postedDate: t.postedDate,
      orderId: t.relatedIdentifiers?.find((id) => id.relatedIdentifierName?.toLowerCase().includes("order"))?.relatedIdentifierValue,
      sku: t.relatedIdentifiers?.find((id) => id.relatedIdentifierName?.toLowerCase().includes("sku"))?.relatedIdentifierValue,
      breakdowns: (t.breakdowns || []).map((b) => ({
        type: b.breakdownType || "Unknown",
        amount: Number(b.breakdownAmount?.currencyAmount || 0),
        currency: b.breakdownAmount?.currencyCode || t.totalAmount?.currencyCode || "EUR",
      })),
      relatedIdentifiers: (t.relatedIdentifiers || []).map((id) => ({
        name: id.relatedIdentifierName,
        value: id.relatedIdentifierValue,
      })),
    }));

    const manualExpenses = await this.listManualExpenses(defaultStart.slice(0, 7));
    const manualTotal = manualExpenses.reduce((sum, expense) => sum + Number(expense.amount), 0);

    cachedSummary = {
      periodStart: defaultStart,
      totalNet: Math.round(totalNet * 100) / 100,
      manualExpensesTotal: Math.round(manualTotal * 100) / 100,
      operatingProfit: Math.round((totalNet - manualTotal) * 100) / 100,
      grossShipments: Math.round(grossShipments * 100) / 100,
      totalRefunds: Math.round(totalRefunds * 100) / 100,
      reimbursements: Math.round(reimbursements * 100) / 100,
      serviceFees: Math.round(serviceFees * 100) / 100,
      transfers: Math.round(transfers * 100) / 100,
      otherAdjustments: Math.round(otherAdjustments * 100) / 100,
      byType,
      byBreakdown,
      transactionCount: transactions.length,
      nextToken,
      transactions: detailedTransactions,
      recentTransactions,
    };

    lastFetchTimestamp = now;
    return cachedSummary;
  }
}
