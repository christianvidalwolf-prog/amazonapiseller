import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { SpApiClient } from "../../spapi/client";
import { createReport, downloadReportDocument, getReport, getReportDocument } from "../../spapi/endpoints/reports";
import { sleep } from "../../spapi/rateLimiter";

export interface AccountHealthMetric {
  title: string;
  rate: number;
  ratePercent: string;
  target: string;
  targetValue: number;
  status: "GOOD" | "WARNING" | "BAD";
  orderCount?: number;
  defectCount?: number;
  description: string;
}

export interface PolicyViolationItem {
  key: string;
  title: string;
  count: number;
  status: "GOOD" | "BAD";
  target: number;
}

export interface AccountHealthSnapshot {
  accountStatus: string;
  marketplaceId: string;
  ahr: {
    score: number;
    status: string;
    maxScore: number;
  };
  metrics: {
    odrAfn: AccountHealthMetric; // FBA
    odrMfn: AccountHealthMetric; // Merchant
    lateShipmentRate: AccountHealthMetric;
    onTimeDeliveryRate: AccountHealthMetric;
    cancellationRate: AccountHealthMetric;
    invoiceDefectRate: AccountHealthMetric;
    validTrackingRate: AccountHealthMetric;
  };
  policyCompliance: PolicyViolationItem[];
  fetchedAt: string;
  cached: boolean;
}

const CACHE_FILE = "account_health_snapshot.json";
const REPORT_TYPE = "GET_V2_SELLER_PERFORMANCE_REPORT";

export class AccountHealthService {
  private cache: AccountHealthSnapshot | null = null;
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos

  constructor(private readonly client: SpApiClient, private readonly marketplaceIds: string[]) {
    this.tryLoadFromDisk();
  }

  async getAccountHealth(forceRefresh = false): Promise<AccountHealthSnapshot> {
    const now = Date.now();
    if (!forceRefresh && this.cache && now - this.cacheTimestamp < this.CACHE_TTL_MS) {
      return { ...this.cache, cached: true };
    }

    try {
      const rawData = await this.fetchLiveReport();
      const snapshot = this.parseReportData(rawData);
      this.cache = snapshot;
      this.cacheTimestamp = now;
      this.saveToDisk(snapshot);
      return { ...snapshot, cached: false };
    } catch (err) {
      // Si falla la llamada en vivo, usar caché de disco existente si existe
      if (this.cache) {
        return { ...this.cache, cached: true };
      }
      throw err;
    }
  }

  private async fetchLiveReport(): Promise<Record<string, unknown>> {
    const { reportId } = await createReport(this.client, {
      reportType: REPORT_TYPE,
      marketplaceIds: this.marketplaceIds,
    });

    const maxAttempts = 30;
    const pollIntervalMs = 3000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(pollIntervalMs);
      const status = await getReport(this.client, reportId);

      if (status.processingStatus === "DONE") {
        if (!status.reportDocumentId) {
          throw new Error("Reporte de rendimiento completado sin reportDocumentId");
        }

        const document = await getReportDocument(this.client, status.reportDocumentId);
        const buffer = await downloadReportDocument(document);
        const jsonString = buffer.toString("utf-8");
        return JSON.parse(jsonString) as Record<string, unknown>;
      }

      if (status.processingStatus === "FATAL" || status.processingStatus === "CANCELLED") {
        throw new Error(`Reporte de rendimiento finalizó con estado: ${status.processingStatus}`);
      }
    }

    throw new Error(`Tiempo de espera agotado esperando el reporte ${reportId}`);
  }

  private parseReportData(data: Record<string, unknown>): AccountHealthSnapshot {
    const accountStatuses = (data.accountStatuses as Array<Record<string, unknown>>) || [];
    const perfList = (data.performanceMetrics as Array<Record<string, unknown>>) || [];
    const pm = perfList[0] || {};

    const accStatus = accountStatuses[0] || {};
    const marketplaceId = String(accStatus.marketplaceId || this.marketplaceIds[0]);
    const accountStatus = String(accStatus.status || "NORMAL");

    // AHR
    const ahrObj = (pm.accountHealthRating as Record<string, unknown>) || {};
    const ahrScore = Number(ahrObj.ahrScore) || 250;
    const ahrStatus = String(ahrObj.ahrStatus || "GOOD");

    // ODR AFN (FBA)
    const odrObj = (pm.orderDefectRate as Record<string, unknown>) || {};
    const afnObj = (odrObj.afn as Record<string, unknown>) || {};
    const mfnObj = (odrObj.mfn as Record<string, unknown>) || {};

    const odrAfnRate = Number(afnObj.rate) || 0;
    const odrMfnRate = Number(mfnObj.rate) || 0;

    // Métricas operativas
    const lateShip = (pm.lateShipmentRate as Record<string, unknown>) || {};
    const onTimeDeliv = (pm.onTimeDeliveryRate as Record<string, unknown>) || {};
    const cancelRate = (pm.preFulfillmentCancellationRate as Record<string, unknown>) || {};
    const invoiceDefect = (pm.invoiceDefectRate as Record<string, unknown>) || {};
    const validTracking = (pm.validTrackingRate as Record<string, unknown>) || {};

    const metrics = {
      odrAfn: {
        title: "Ratio de Defectos en Pedidos (FBA)",
        rate: odrAfnRate,
        ratePercent: `${(odrAfnRate * 100).toFixed(2)}%`,
        target: "< 1.00%",
        targetValue: 0.01,
        status: (odrAfnRate < 0.01 ? "GOOD" : "BAD") as "GOOD" | "BAD",
        orderCount: Number(afnObj.orderCount) || 0,
        defectCount: Number((afnObj.orderWithDefects as Record<string, unknown>)?.count) || 0,
        description: "Reclamaciones de la A a la Z, valoraciones negativas y contracargos gestionados por Amazon FBA.",
      },
      odrMfn: {
        title: "Ratio de Defectos en Pedidos (FBM / Vendedor)",
        rate: odrMfnRate,
        ratePercent: `${(odrMfnRate * 100).toFixed(2)}%`,
        target: "< 1.00%",
        targetValue: 0.01,
        status: (odrMfnRate < 0.01 ? "GOOD" : "BAD") as "GOOD" | "BAD",
        orderCount: Number(mfnObj.orderCount) || 0,
        defectCount: Number((mfnObj.orderWithDefects as Record<string, unknown>)?.count) || 0,
        description: "Defectos en pedidos con gestión logística propia.",
      },
      lateShipmentRate: {
        title: "Ratio de Envíos Tardíos (LSR)",
        rate: Number(lateShip.rate) || 0,
        ratePercent: `${((Number(lateShip.rate) || 0) * 100).toFixed(2)}%`,
        target: "< 4.00%",
        targetValue: 0.04,
        status: (Number(lateShip.rate) < 0.04 ? "GOOD" : "BAD") as "GOOD" | "BAD",
        orderCount: Number(lateShip.orderCount) || 0,
        defectCount: Number(lateShip.lateShipmentCount) || 0,
        description: "Pedidos confirmados para envío después de la fecha límite prevista.",
      },
      onTimeDeliveryRate: {
        title: "Ratio de Entregas a Tiempo (OTDR)",
        rate: Number(onTimeDeliv.rate) || 1,
        ratePercent: `${((Number(onTimeDeliv.rate) || 1) * 100).toFixed(1)}%`,
        target: "> 97.00%",
        targetValue: 0.97,
        status: ((Number(onTimeDeliv.rate) || 1) >= 0.97 ? "GOOD" : "BAD") as "GOOD" | "BAD",
        orderCount: Number(onTimeDeliv.shipmentCountWithValidTracking) || 0,
        defectCount:
          (Number(onTimeDeliv.shipmentCountWithValidTracking) || 0) - (Number(onTimeDeliv.onTimeDeliveryCount) || 0),
        description: "Envíos con seguimiento entregados antes o en la fecha prevista de entrega.",
      },
      cancellationRate: {
        title: "Cancelaciones Previas al Envío (CR)",
        rate: Number(cancelRate.rate) || 0,
        ratePercent: `${((Number(cancelRate.rate) || 0) * 100).toFixed(2)}%`,
        target: "< 2.50%",
        targetValue: 0.025,
        status: (Number(cancelRate.rate) < 0.025 ? "GOOD" : "BAD") as "GOOD" | "BAD",
        orderCount: Number(cancelRate.orderCount) || 0,
        defectCount: Number(cancelRate.cancellationCount) || 0,
        description: "Pedidos cancelados por el vendedor antes de confirmar el envío.",
      },
      invoiceDefectRate: {
        title: "Ratio de Defectos en Facturación (IDR)",
        rate: Number(invoiceDefect.rate) || 0,
        ratePercent: `${((Number(invoiceDefect.rate) || 0) * 100).toFixed(2)}%`,
        target: "< 5.00%",
        targetValue: 0.05,
        status: (Number(invoiceDefect.rate) < 0.05 ? "GOOD" : "BAD") as "GOOD" | "BAD",
        orderCount: Number(invoiceDefect.orderCount) || 0,
        defectCount: Number((invoiceDefect.invoiceDefect as Record<string, unknown>)?.count) || 0,
        description: "Facturas no subidas dentro del plazo establecido a clientes comerciales.",
      },
      validTrackingRate: {
        title: "Ratio de Seguimiento Válido (VTR)",
        rate: Number(validTracking.rate) || 0,
        ratePercent: `${((Number(validTracking.rate) || 0) * 100).toFixed(1)}%`,
        target: "> 95.00%",
        targetValue: 0.95,
        status: ((Number(validTracking.rate) || 0) >= 0.95 ? "GOOD" : "WARNING") as "GOOD" | "WARNING",
        orderCount: Number(validTracking.shipmentCount) || 0,
        defectCount: 0,
        description: "Porcentaje de envíos con número de seguimiento reconocido por Amazon.",
      },
    };

    // Políticas de cumplimiento
    const policyDefs: Array<{ key: string; title: string }> = [
      { key: "receivedIntellectualPropertyComplaints", title: "Quejas de Propiedad Intelectual Recibidas" },
      { key: "suspectedIntellectualPropertyViolations", title: "Infracciones Sospechadas de Propiedad Intelectual" },
      { key: "productAuthenticityCustomerComplaints", title: "Reclamaciones sobre Autenticidad del Producto" },
      { key: "productConditionCustomerComplaints", title: "Reclamaciones sobre el Estado del Producto" },
      { key: "productSafetyCustomerComplaints", title: "Reclamaciones sobre Seguridad del Producto" },
      { key: "listingPolicyViolations", title: "Infracciones de Políticas de Catálogo / Listings" },
      { key: "restrictedProductPolicyViolations", title: "Infracciones de Productos Restringidos" },
      { key: "customerProductReviewsPolicyViolations", title: "Infracciones de Políticas de Reseñas de Clientes" },
      { key: "otherPolicyViolations", title: "Otras Infracciones de Políticas" },
    ];

    const policyCompliance: PolicyViolationItem[] = policyDefs.map((p) => {
      const obj = (pm[p.key] as Record<string, unknown>) || {};
      const count = Number(obj.defectsCount) || 0;
      const status = count === 0 ? "GOOD" : "BAD";
      return {
        key: p.key,
        title: p.title,
        count,
        status,
        target: 0,
      };
    });

    return {
      accountStatus,
      marketplaceId,
      ahr: {
        score: ahrScore,
        status: ahrStatus,
        maxScore: 1000,
      },
      metrics,
      policyCompliance,
      fetchedAt: new Date().toISOString(),
      cached: false,
    };
  }

  private tryLoadFromDisk(): void {
    const diskPath = path.resolve(process.cwd(), CACHE_FILE);
    const altDiskPath = path.resolve(process.cwd(), "..", CACHE_FILE);
    const target = fs.existsSync(diskPath) ? diskPath : fs.existsSync(altDiskPath) ? altDiskPath : null;

    if (target) {
      try {
        const raw = fs.readFileSync(target, "utf-8");
        this.cache = JSON.parse(raw);
        this.cacheTimestamp = Date.now();
      } catch {
        // ignore
      }
    }
  }

  private saveToDisk(snapshot: AccountHealthSnapshot): void {
    try {
      const diskPath = path.resolve(process.cwd(), CACHE_FILE);
      fs.writeFileSync(diskPath, JSON.stringify(snapshot, null, 2), "utf-8");
    } catch {
      // ignore
    }
  }
}
