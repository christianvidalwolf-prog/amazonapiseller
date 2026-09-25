import type { PrismaClient } from "@prisma/client";
import type { SpApiClient } from "../../spapi/client";
import { listTransactions, type TransactionItem } from "../../spapi/endpoints/finances";

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
  pnl: Array<{ key: string; label: string; amount: number; count: number; children: Array<{ key: string; label: string; amount: number; count: number }> }>;
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

type PnlBucket = { amount: number; count: number; children: Map<string, { amount: number; count: number }> };

const PNL_LABELS: Record<string, string> = {
  revenue: "Ventas",
  refunds: "Reembolsos y devoluciones",
  advertising: "Costes publicitarios",
  shipping: "Envíos y logística",
  amazonFees: "Tarifas de Amazon",
  cogs: "Coste de los bienes",
  reimbursements: "Indemnizaciones y ajustes positivos",
  other: "Otros ajustes Amazon",
};

function classifyBreakdown(transactionType: string, breakdown: string): { category: string; label: string } {
  const text = `${transactionType} ${breakdown}`.toLowerCase();
  if (transactionType === "Refund" || /refund|return|reembolso|devolu/.test(text)) return { category: "refunds", label: breakdown };
  if (transactionType === "Shipment" && /principal|product|item|sales|revenue|tax/.test(text)) return { category: "revenue", label: breakdown };
  if (/advertis|sponsored|ppc/.test(text)) return { category: "advertising", label: breakdown };
  if (/shipping|shipment|delivery|transport|env[ií]o|fulfilment|fulfillment/.test(text)) return { category: "shipping", label: breakdown };
  if (/cogs|cost.of.goods|product.cost|inventor|disposal|unsellable|multi.channel/.test(text)) return { category: "cogs", label: breakdown };
  if (/reimburse|indemn|goodwill|lost|damage|warehouse|liquidation/.test(text)) return { category: "reimbursements", label: breakdown };
  if (transactionType === "ServiceFee" || /fee|tariff|subscription|storage|referral|commission|epr|label|polybag|coupon|promotion|promo/.test(text)) return { category: "amazonFees", label: breakdown };
  return { category: "other", label: breakdown };
}

function buildPnl(transactions: TransactionItem[]) {
  const buckets = new Map<string, PnlBucket>();
  const add = (category: string, label: string, amount: number, count: number) => {
    const bucket = buckets.get(category) || { amount: 0, count: 0, children: new Map() };
    bucket.amount += amount; bucket.count += count;
    const child = bucket.children.get(label) || { amount: 0, count: 0 };
    child.amount += amount; child.count += count; bucket.children.set(label, child); buckets.set(category, bucket);
  };
  for (const t of transactions) {
    const amount = Number(t.totalAmount?.currencyAmount || 0);
    if (!(t.breakdowns || []).length) {
      const category = t.transactionType === "Shipment" ? "revenue" : t.transactionType === "Refund" ? "refunds" : t.transactionType === "ServiceFee" ? "amazonFees" : t.transactionType === "FBAInventoryReimbursement" ? "reimbursements" : "other";
      add(category, t.transactionType || "Otros", amount, 1);
    }
    for (const b of t.breakdowns || []) {
      const amount = Number(b.breakdownAmount?.currencyAmount || 0);
      const mapped = classifyBreakdown(t.transactionType || "Other", b.breakdownType || "Unknown");
      add(mapped.category, mapped.label, amount, 1);
    }
  }
  return Array.from(buckets.entries()).map(([key, bucket]) => ({ key, label: PNL_LABELS[key] || key, amount: Math.round(bucket.amount * 100) / 100, count: bucket.count, children: Array.from(bucket.children.entries()).map(([childKey, child]) => ({ key: childKey, label: childKey, amount: Math.round(child.amount * 100) / 100, count: child.count })).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)) })).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

// Caché en memoria para no saturar los rate limits de Amazon
const summaryCache = new Map<string, { data: FinanceSummary; timestamp: number }>();
const annualCache = new Map<number, { data: any; timestamp: number }>();
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
    // Invalidate caches for this period and year
    summaryCache.clear();
    annualCache.clear();
    return this.prisma.manualExpense.create({ data: {
      sellerId: this.sellerId, category: input.category, description: input.description,
      allocationType: input.allocationType, amount: input.amount, currency: input.currency || "EUR",
      period: new Date(`${input.period}-01T00:00:00.000Z`), orderId: input.orderId, sku: input.sku,
      quantity: input.quantity, unitAmount: input.unitAmount,
    } });
  }

  async deleteManualExpense(id: string) {
    if (!this.prisma) throw new Error("Database is not configured");
    summaryCache.clear();
    annualCache.clear();
    return this.prisma.manualExpense.deleteMany({ where: { id, sellerId: this.sellerId } });
  }

  async getAnnualFinanceSummary(year: number, forceRefresh = false) {
    const now = new Date();
    const currentYear = now.getUTCFullYear();

    if (!forceRefresh) {
      const cached = annualCache.get(year);
      if (cached && (Date.now() - cached.timestamp < (year < currentYear ? 24 * 3600 * 1000 : CACHE_TTL_MS))) {
        return cached.data;
      }
    }

    const periods = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      return `${year}-${String(m).padStart(2, "0")}`;
    });

    if (year > currentYear) {
      const emptyMonths = periods.map((period, i) => ({
        month: i + 1,
        period,
        periodStart: `${period}-01T00:00:00.000Z`,
        totalNet: 0,
        manualExpensesTotal: 0,
        operatingProfit: 0,
        grossShipments: 0,
        totalRefunds: 0,
        reimbursements: 0,
        serviceFees: 0,
        transfers: 0,
        otherAdjustments: 0,
        byType: [],
        byBreakdown: [],
        pnl: [],
        transactionCount: 0,
        transactions: [],
        recentTransactions: [],
      }));
      return {
        year,
        months: emptyMonths,
        total: {
          totalNet: 0,
          grossShipments: 0,
          manualExpensesTotal: 0,
          operatingProfit: 0,
          serviceFees: 0,
          totalRefunds: 0,
          reimbursements: 0,
        },
      };
    }

    const quarters = [
      { start: new Date(Date.UTC(year, 0, 1, 0, 0, 0)), end: new Date(Date.UTC(year, 2, 31, 23, 59, 59, 999)) },
      { start: new Date(Date.UTC(year, 3, 1, 0, 0, 0)), end: new Date(Date.UTC(year, 5, 30, 23, 59, 59, 999)) },
      { start: new Date(Date.UTC(year, 6, 1, 0, 0, 0)), end: new Date(Date.UTC(year, 8, 30, 23, 59, 59, 999)) },
      { start: new Date(Date.UTC(year, 9, 1, 0, 0, 0)), end: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)) },
    ];

    const transactions: TransactionItem[] = [];
    const nowTime = Date.now();

    for (const q of quarters) {
      if (q.start.getTime() > nowTime) continue; // Trimestre en el futuro

      const postedAfter = q.start.toISOString();
      const endLimit = Math.min(q.end.getTime(), nowTime - 3 * 60 * 1000);
      const postedBefore = new Date(endLimit).toISOString();

      let nextToken: string | undefined;
      try {
        do {
          const response = await listTransactions(this.client, {
            postedAfter,
            postedBefore,
            nextToken,
          });
          transactions.push(...(response.payload?.transactions || []));
          nextToken = response.payload?.nextToken || response.nextToken;
        } while (nextToken);
      } catch (err) {
        console.error(`Error al consultar transacciones del trimestre (${postedAfter} - ${postedBefore}):`, err);
      }
    }

    const txByMonth = new Map<string, TransactionItem[]>();
    for (const p of periods) {
      txByMonth.set(p, []);
    }
    for (const t of transactions) {
      const p = t.postedDate ? t.postedDate.slice(0, 7) : undefined;
      if (p && txByMonth.has(p)) {
        txByMonth.get(p)!.push(t);
      }
    }

    let annualExpenses: Array<{ period: Date; amount: any }> = [];
    if (this.prisma) {
      try {
        annualExpenses = await this.prisma.manualExpense.findMany({
          where: {
            sellerId: this.sellerId,
            period: {
              gte: new Date(Date.UTC(year, 0, 1)),
              lte: new Date(Date.UTC(year, 11, 31, 23, 59, 59)),
            },
          },
        });
      } catch (err) {
        console.error("Error al consultar gastos manuales anuales:", err);
      }
    }

    const expensesByMonth = new Map<string, number>();
    for (const exp of annualExpenses) {
      const p = exp.period.toISOString().slice(0, 7);
      expensesByMonth.set(p, (expensesByMonth.get(p) || 0) + Number(exp.amount || 0));
    }

    const months: Array<FinanceSummary & { month: number; period: string }> = [];

    for (let i = 0; i < 12; i += 1) {
      const monthNum = i + 1;
      const period = periods[i];
      const monthTxs = txByMonth.get(period) || [];
      const manualTotal = Math.round((expensesByMonth.get(period) || 0) * 100) / 100;

      let grossShipments = 0;
      let totalRefunds = 0;
      let reimbursements = 0;
      let serviceFees = 0;
      let transfers = 0;
      let otherAdjustments = 0;
      let totalNet = 0;

      for (const t of monthTxs) {
        const amt = Number(t.totalAmount?.currencyAmount || 0);
        totalNet += amt;
        const type = t.transactionType || "Other";
        switch (type) {
          case "Shipment": grossShipments += amt; break;
          case "Refund": totalRefunds += amt; break;
          case "FBAInventoryReimbursement": reimbursements += amt; break;
          case "ServiceFee": serviceFees += amt; break;
          case "Transfer": transfers += amt; break;
          default: otherAdjustments += amt; break;
        }
      }

      totalNet = Math.round(totalNet * 100) / 100;
      grossShipments = Math.round(grossShipments * 100) / 100;
      totalRefunds = Math.round(totalRefunds * 100) / 100;
      reimbursements = Math.round(reimbursements * 100) / 100;
      serviceFees = Math.round(serviceFees * 100) / 100;
      transfers = Math.round(transfers * 100) / 100;
      otherAdjustments = Math.round(otherAdjustments * 100) / 100;
      const operatingProfit = Math.round((totalNet - manualTotal) * 100) / 100;
      const pnl = buildPnl(monthTxs);

      months.push({
        month: monthNum,
        period,
        periodStart: `${period}-01T00:00:00.000Z`,
        totalNet,
        manualExpensesTotal: manualTotal,
        operatingProfit,
        grossShipments,
        totalRefunds,
        reimbursements,
        serviceFees,
        transfers,
        otherAdjustments,
        byType: [],
        byBreakdown: [],
        pnl,
        transactionCount: monthTxs.length,
        transactions: [],
        recentTransactions: [],
      });
    }

    const sum = (key: "totalNet" | "grossShipments" | "manualExpensesTotal" | "operatingProfit" | "serviceFees" | "totalRefunds" | "reimbursements") =>
      months.reduce((total, item) => total + Number(item[key] || 0), 0);

    const result = {
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

    annualCache.set(year, { data: result, timestamp: Date.now() });
    return result;
  }

  async getFinanceSummary(postedAfter?: string, forceRefresh = false): Promise<FinanceSummary> {
    const defaultStart = postedAfter || new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();

    // Si la fecha de inicio está en el futuro, no llamar a Amazon (Amazon devuelve error 500)
    if (new Date(defaultStart).getTime() > Date.now()) {
      return {
        periodStart: defaultStart,
        totalNet: 0,
        manualExpensesTotal: 0,
        operatingProfit: 0,
        grossShipments: 0,
        totalRefunds: 0,
        reimbursements: 0,
        serviceFees: 0,
        transfers: 0,
        otherAdjustments: 0,
        byType: [],
        byBreakdown: [],
        pnl: [],
        transactionCount: 0,
        transactions: [],
        recentTransactions: [],
      };
    }

    // Calcular postedBefore si se pasa un mes específico (ej: 2026-08-01...)
    let postedBefore: string | undefined;
    try {
      const d = new Date(defaultStart);
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth();
      const endOfMonth = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
      if (endOfMonth.getTime() < Date.now()) {
        postedBefore = endOfMonth.toISOString();
      } else {
        postedBefore = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      }
    } catch {}

    const cacheKey = `${defaultStart}_${postedBefore || "now"}`;
    if (!forceRefresh) {
      const cached = summaryCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.data;
      }
    }

    const transactions: TransactionItem[] = [];
    let nextToken: string | undefined;
    do {
      const response = await listTransactions(this.client, {
        postedAfter: defaultStart,
        postedBefore,
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
    const manualTotal = manualExpenses.reduce(
      (sum: number, expense: { amount: unknown }) => sum + Number(expense.amount),
      0,
    );

    const summary: FinanceSummary = {
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
      pnl: buildPnl(transactions),
      transactionCount: transactions.length,
      nextToken,
      transactions: detailedTransactions,
      recentTransactions,
    };

    summaryCache.set(cacheKey, { data: summary, timestamp: Date.now() });
    return summary;
  }
}
