import fs from "node:fs";
import path from "node:path";
import type { SpApiClient } from "../../spapi/client";
import {
  createReport,
  downloadReportDocument,
  getReport,
  getReportDocument,
  getReports,
} from "../../spapi/endpoints/reports";
import { sleep } from "../../spapi/rateLimiter";

export interface ReimbursementClaimItem {
  id: string;
  category: "WAREHOUSE_DAMAGED" | "CARRIER_DAMAGED" | "CUSTOMER_RETURN_MISSING" | "SWITCHEROO";
  categoryLabel: string;
  orderId: string;
  sku: string;
  asin: string;
  productName: string;
  salesChannel: string;
  countryCode: string;
  eventDate: string;
  fnsku: string;
  lpn: string;
  disposition: string;
  reason: string;
  estimatedAmount: number;
  currency: string;
  status: "PENDING_CLAIM" | "REIMBURSED" | "EXPIRED";
  daysPending: number;
  caseTemplate: string;
}

export interface ReimbursementRecord {
  approvalDate: string;
  reimbursementId: string;
  caseId: string;
  amazonOrderId: string;
  reason: string;
  sku: string;
  fnsku: string;
  asin: string;
  productName: string;
  condition: string;
  currencyUnit: string;
  amountPerUnit: number;
  amountTotal: number;
  quantityTotal: number;
}

export interface ReimbursementsAuditSummary {
  updatedAt: string;
  totalPendingAmount: number;
  totalPendingClaims: number;
  totalHistoricalReimbursed: number;
  totalHistoricalRecords: number;
  availableMarketplaces: Array<{ code: string; name: string; count: number; totalAmount: number }>;
  claimsByCategory: Array<{ category: string; label: string; count: number; totalAmount: number }>;
  claims: ReimbursementClaimItem[];
  recentReimbursements: ReimbursementRecord[];
}

export class ReimbursementsAuditService {
  constructor(
    private readonly client: SpApiClient,
    private readonly marketplaceIds: string[],
    private readonly sellerId: string
  ) {}

  private parseTabDelimited(text: string): Record<string, string>[] {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const header = lines[0].split("\t").map((h) => h.trim().replace(/^\uFEFF/, ""));
    const rows: Record<string, string>[] = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split("\t");
      const row: Record<string, string> = {};
      for (let j = 0; j < header.length; j++) {
        row[header[j]] = (parts[j] || "").trim();
      }
      rows.push(row);
    }
    return rows;
  }

  private parseCsvSemicolon(text: string): Record<string, string>[] {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const header = lines[0].split(";").map((h) => h.trim().replace(/^\uFEFF/, ""));
    const rows: Record<string, string>[] = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(";");
      const row: Record<string, string> = {};
      for (let j = 0; j < header.length; j++) {
        row[header[j]] = (parts[j] || "").trim();
      }
      rows.push(row);
    }
    return rows;
  }

  private loadFile(filename: string): string | null {
    const candidatePaths = [
      path.resolve(process.cwd(), filename),
      path.resolve(process.cwd(), "..", filename),
      path.resolve(process.cwd(), "backend", filename),
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        try {
          return fs.readFileSync(p, "utf-8");
        } catch {
          // continue
        }
      }
    }
    return null;
  }

  private async fetchReimbursementsReport(): Promise<string> {
    const localContent = this.loadFile("reembolsos_historico.tsv");
    if (localContent && localContent.length > 500) {
      return localContent;
    }

    try {
      const existing = await getReports(this.client, {
        reportTypes: ["GET_FBA_REIMBURSEMENTS_DATA"],
        processingStatuses: ["DONE"],
        pageSize: 5,
      });

      const doneReport = existing.reports?.[0];
      if (doneReport?.reportDocumentId) {
        const doc = await getReportDocument(this.client, doneReport.reportDocumentId);
        const buf = await downloadReportDocument(doc);
        return buf.toString("utf-8");
      }

      const created = await createReport(this.client, {
        reportType: "GET_FBA_REIMBURSEMENTS_DATA",
        marketplaceIds: this.marketplaceIds,
        dataStartTime: new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString(),
      });

      for (let attempt = 0; attempt < 12; attempt++) {
        await sleep(5000);
        const status = await getReport(this.client, created.reportId);
        if (status.processingStatus === "DONE" && status.reportDocumentId) {
          const doc = await getReportDocument(this.client, status.reportDocumentId);
          const buf = await downloadReportDocument(doc);
          const text = buf.toString("utf-8");
          const savePath = path.resolve(process.cwd(), "..", "reembolsos_historico.tsv");
          fs.writeFileSync(savePath, text, "utf-8");
          return text;
        }
        if (status.processingStatus === "FATAL" || status.processingStatus === "CANCELLED") break;
      }
    } catch (err) {
      console.warn("Error fetching live reimbursements report from SP-API:", err);
    }

    return "";
  }

  private channelToCountryCode(channel: string): string {
    const lower = (channel || "").toLowerCase();
    if (lower.includes(".es")) return "ES";
    if (lower.includes(".de")) return "DE";
    if (lower.includes(".fr")) return "FR";
    if (lower.includes(".it")) return "IT";
    if (lower.includes(".be")) return "BE";
    if (lower.includes(".nl")) return "NL";
    if (lower.includes(".pl")) return "PL";
    if (lower.includes(".se")) return "SE";
    if (lower.includes(".co.uk") || lower.includes(".uk")) return "UK";
    return "ES";
  }

  async getAuditSummary(targetCountry = "ALL"): Promise<ReimbursementsAuditSummary> {
    const reimbursementsRaw = await this.fetchReimbursementsReport();
    const reimbursementRows = this.parseTabDelimited(reimbursementsRaw);

    const returnsRaw2026 = this.loadFile("devoluciones_2026.csv") || "";
    const returnsRaw2025 = this.loadFile("devoluciones_2025.csv") || "";
    const returnRows = [
      ...this.parseTabDelimited(returnsRaw2026),
      ...this.parseTabDelimited(returnsRaw2025),
    ];

    const salesRaw2026 = this.loadFile("ventas_2026.csv") || "";
    const salesRaw2025 = this.loadFile("ventas_2025.csv") || "";
    const orderRows = [
      ...this.parseCsvSemicolon(salesRaw2026),
      ...this.parseCsvSemicolon(salesRaw2025),
    ];

    const orderLookup = new Map<
      string,
      { channel: string; price: number; currency: string; sku: string; asin: string; name: string; date: string }
    >();

    for (const ord of orderRows) {
      const oId = ord["amazon-order-id"]?.trim();
      if (!oId) continue;
      const ch = ord["sales-channel"]?.trim() || "Amazon.es";
      const price = parseFloat((ord["item-price"] || "0").replace(",", ".")) || 0;
      const sku = ord["sku"]?.trim() || "";
      const asin = ord["asin"]?.trim() || "";
      const name = ord["product-name"]?.trim() || sku;
      const date = ord["purchase-date"]?.trim() || "";
      const currency = ord["currency"]?.trim() || "EUR";

      const key = `${oId}|${sku}`;
      const info = { channel: ch, price, currency, sku, asin, name, date };
      orderLookup.set(key, info);
      if (!orderLookup.has(oId)) orderLookup.set(oId, info);
    }

    const reimbursedOrderIds = new Set<string>();
    const reimbursedKeySet = new Set<string>();
    const parsedReimbursements: ReimbursementRecord[] = [];
    let totalReimbursedEur = 0;

    for (const r of reimbursementRows) {
      const oId = r["amazon-order-id"]?.trim() || "";
      const sku = r["sku"]?.trim() || "";
      const amount = parseFloat(r["amount-total"] || "0") || 0;
      const currency = r["currency-unit"]?.trim() || "EUR";

      if (oId) reimbursedOrderIds.add(oId);
      if (oId && sku) reimbursedKeySet.add(`${oId}|${sku}`);

      if (currency === "EUR") {
        totalReimbursedEur += amount;
      }

      parsedReimbursements.push({
        approvalDate: r["approval-date"] || "",
        reimbursementId: r["reimbursement-id"] || "",
        caseId: r["case-id"] || "",
        amazonOrderId: oId,
        reason: r["reason"] || "",
        sku,
        fnsku: r["fnsku"] || "",
        asin: r["asin"] || "",
        productName: r["product-name"] || "",
        condition: r["condition"] || "",
        currencyUnit: currency,
        amountPerUnit: parseFloat(r["amount-per-unit"] || "0") || 0,
        amountTotal: amount,
        quantityTotal: parseInt(r["quantity-reimbursed-total"] || "1", 10) || 1,
      });
    }

    const claims: ReimbursementClaimItem[] = [];
    const nowTs = Date.now();

    for (const ret of returnRows) {
      const oId = ret["order-id"]?.trim() || "";
      const sku = ret["sku"]?.trim() || "";
      const disp = (ret["detailed-disposition"] || "").toUpperCase().trim();
      const reason = (ret["reason"] || "").toUpperCase().trim();
      const returnDate = ret["return-date"]?.trim() || "";

      if (!oId || !sku) continue;

      const orderInfo = orderLookup.get(`${oId}|${sku}`) || orderLookup.get(oId);
      const channel = orderInfo?.channel || "Amazon.es";
      const countryCode = this.channelToCountryCode(channel);
      const itemPrice = orderInfo?.price && orderInfo.price > 0 ? orderInfo.price : 14.95;
      const asin = ret["asin"] || orderInfo?.asin || "";
      const name = ret["product-name"] || orderInfo?.name || sku;
      const fnsku = ret["fnsku"] || "";
      const lpn = ret["license-plate-number"] || "";

      const isReimbursed = reimbursedOrderIds.has(oId) || reimbursedKeySet.has(`${oId}|${sku}`);
      if (isReimbursed) continue;

      const returnTs = Date.parse(returnDate);
      const daysPending = isNaN(returnTs) ? 30 : Math.max(1, Math.floor((nowTs - returnTs) / (1000 * 3600 * 24)));

      if (reason === "DAMAGED_BY_FC") {
        claims.push({
          id: `claim-fc-${oId}-${sku}`,
          category: "WAREHOUSE_DAMAGED",
          categoryLabel: "Dañado por Amazon en Almacén",
          orderId: oId,
          sku,
          asin,
          productName: name,
          salesChannel: channel,
          countryCode,
          eventDate: returnDate,
          fnsku,
          lpn,
          disposition: disp,
          reason,
          estimatedAmount: Math.round(itemPrice * 100) / 100,
          currency: "EUR",
          status: "PENDING_CLAIM",
          daysPending,
          caseTemplate: `Estimado equipo de soporte de Amazon Seller Central,\n\nSolicito el reembolso correspondiente al pedido ${oId} (SKU: ${sku}, ASIN: ${asin}, LPN: ${lpn}).\nLa unidad devuelta ha sido categorizada internamente por Amazon como DAMAGED_BY_FC (dañada por el centro logístico FBA) en el reporte de devoluciones con fecha ${returnDate}.\n\nDado que el daño se produjo bajo custodia de Amazon, procede la correspondiente indemnización conforme a la política de reembolso por inventario extraviado o dañado de FBA.\n\nQuedo a la espera de su resolución.\nMuchas gracias.`,
        });
      } else if (disp === "CARRIER_DAMAGED" || reason === "DAMAGED_BY_CARRIER") {
        claims.push({
          id: `claim-carrier-${oId}-${sku}`,
          category: "CARRIER_DAMAGED",
          categoryLabel: "Dañado durante Transporte FBA",
          orderId: oId,
          sku,
          asin,
          productName: name,
          salesChannel: channel,
          countryCode,
          eventDate: returnDate,
          fnsku,
          lpn,
          disposition: disp,
          reason,
          estimatedAmount: Math.round(itemPrice * 100) / 100,
          currency: "EUR",
          status: "PENDING_CLAIM",
          daysPending,
          caseTemplate: `Estimado soporte de Amazon Seller Central,\n\nSolicito el reembolso del pedido FBA ${oId} (SKU: ${sku}, ASIN: ${asin}, LPN: ${lpn}).\nEl artículo sufrió daños bajo la custodia del transportista de Amazon (CARRIER_DAMAGED / DAMAGED_BY_CARRIER) durante el envío/retorno del cliente, por lo que el vendedor no debe asumir dicho perjuicio de acuerdo con las condiciones del servicio Logística de Amazon.\n\nPor favor, procedan al abono de la indemnización.\nUn cordial saludo.`,
        });
      } else if (reason === "SWITCHEROO") {
        claims.push({
          id: `claim-switcheroo-${oId}-${sku}`,
          category: "SWITCHEROO",
          categoryLabel: "Devolución Fraudulenta / Cambiazo",
          orderId: oId,
          sku,
          asin,
          productName: name,
          salesChannel: channel,
          countryCode,
          eventDate: returnDate,
          fnsku,
          lpn,
          disposition: disp,
          reason,
          estimatedAmount: Math.round(itemPrice * 100) / 100,
          currency: "EUR",
          status: "PENDING_CLAIM",
          daysPending,
          caseTemplate: `Estimado equipo de Seller Central,\n\nPresento una reclamación por devolución irregular sobre el pedido ${oId} (SKU: ${sku}, ASIN: ${asin}, LPN: ${lpn}).\nEl producto recibido en devolución está marcado como SWITCHEROO (el cliente ha devuelto un artículo distinto o vacío tras recibir el reembolso completo).\n\nSolicito la indemnización del importe de la venta en base a las políticas de protección al vendedor por fraude en devoluciones FBA.\n\nGracias.`,
        });
      }
    }

    claims.sort((a, b) => b.daysPending - a.daysPending);

    const countryMap = new Map<string, { code: string; name: string; count: number; totalAmount: number }>();
    const countryNames: Record<string, string> = {
      ES: "España",
      DE: "Alemania",
      FR: "Francia",
      IT: "Italia",
      BE: "Bélgica",
      NL: "Países Bajos",
      PL: "Polonia",
      SE: "Suecia",
      UK: "Reino Unido",
    };

    for (const c of claims) {
      const code = c.countryCode;
      const existing = countryMap.get(code) || {
        code,
        name: countryNames[code] || code,
        count: 0,
        totalAmount: 0,
      };
      existing.count++;
      existing.totalAmount = Math.round((existing.totalAmount + c.estimatedAmount) * 100) / 100;
      countryMap.set(code, existing);
    }

    const availableMarketplaces = Array.from(countryMap.values()).sort((a, b) => b.totalAmount - a.totalAmount);

    const filteredClaims =
      targetCountry === "ALL"
        ? claims
        : claims.filter((c) => c.countryCode.toUpperCase() === targetCountry.toUpperCase());

    const catMap = new Map<string, { category: string; label: string; count: number; totalAmount: number }>();
    for (const c of filteredClaims) {
      const existing = catMap.get(c.category) || {
        category: c.category,
        label: c.categoryLabel,
        count: 0,
        totalAmount: 0,
      };
      existing.count++;
      existing.totalAmount = Math.round((existing.totalAmount + c.estimatedAmount) * 100) / 100;
      catMap.set(c.category, existing);
    }
    const claimsByCategory = Array.from(catMap.values());

    const totalPendingAmount = Math.round(
      filteredClaims.reduce((sum, c) => sum + c.estimatedAmount, 0) * 100
    ) / 100;

    return {
      updatedAt: new Date().toISOString(),
      totalPendingAmount,
      totalPendingClaims: filteredClaims.length,
      totalHistoricalReimbursed: Math.round(totalReimbursedEur * 100) / 100,
      totalHistoricalRecords: parsedReimbursements.length,
      availableMarketplaces,
      claimsByCategory,
      claims: filteredClaims,
      recentReimbursements: parsedReimbursements.slice(0, 100),
    };
  }
}
