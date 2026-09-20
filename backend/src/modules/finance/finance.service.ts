import type { SpApiClient } from "../../spapi/client";
import { listTransactions, type TransactionItem } from "../../spapi/endpoints/finances";

export interface FinanceSummary {
  periodStart: string;
  totalNet: number;
  grossShipments: number;
  totalRefunds: number;
  reimbursements: number;
  serviceFees: number;
  transfers: number;
  otherAdjustments: number;
  byType: Array<{ type: string; label: string; amount: number; count: number }>;
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
  constructor(private readonly client: SpApiClient) {}

  async getFinanceSummary(postedAfter?: string, forceRefresh = false): Promise<FinanceSummary> {
    const now = Date.now();
    const defaultStart = postedAfter || new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();

    if (!forceRefresh && cachedSummary && now - lastFetchTimestamp < CACHE_TTL_MS) {
      return cachedSummary;
    }

    const response = await listTransactions(this.client, {
      postedAfter: defaultStart,
    });

    const transactions = response.payload?.transactions || [];

    let grossShipments = 0;
    let totalRefunds = 0;
    let reimbursements = 0;
    let serviceFees = 0;
    let transfers = 0;
    let otherAdjustments = 0;
    let totalNet = 0;

    const typeMap = new Map<string, { amount: number; count: number }>();

    for (const t of transactions) {
      const type = t.transactionType || "Other";
      const amt = Number(t.totalAmount?.currencyAmount || 0);

      totalNet += amt;

      const current = typeMap.get(type) || { amount: 0, count: 0 };
      current.amount += amt;
      current.count += 1;
      typeMap.set(type, current);

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

    cachedSummary = {
      periodStart: defaultStart,
      totalNet: Math.round(totalNet * 100) / 100,
      grossShipments: Math.round(grossShipments * 100) / 100,
      totalRefunds: Math.round(totalRefunds * 100) / 100,
      reimbursements: Math.round(reimbursements * 100) / 100,
      serviceFees: Math.round(serviceFees * 100) / 100,
      transfers: Math.round(transfers * 100) / 100,
      otherAdjustments: Math.round(otherAdjustments * 100) / 100,
      byType,
      recentTransactions,
    };

    lastFetchTimestamp = now;
    return cachedSummary;
  }
}
