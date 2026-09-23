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
import { fetchNegativeFeedback, type SellerFeedbackItem } from "./sellerFeedback";

export interface CustomerFeedbackItem {
  date: string;
  rating: number;
  comments: string;
  response?: string;
  orderId: string;
  raterEmail?: string;
}

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

export interface NegativeFeedbackItem {
  orderId: string;
  asin: string;
  marketplaceId: string;
  feedbackDate: string;
  feedbackType: "NEGATIVE_FEEDBACK" | "A_Z_CLAIM" | "CHARGEBACK" | "LISTING_VIOLATION";
  defectCount: number;
  title: string;
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
  negativeFeedbacks: NegativeFeedbackItem[];
  customerFeedback?: CustomerFeedbackItem[];
  fetchedAt: string;
  cached: boolean;
}

export interface MarketplaceInfo {
  id: string;
  code: string;
  name: string;
}

export const EU_MARKETPLACES: Record<string, MarketplaceInfo> = {
  ES: { id: "A1RKKUPIHCS9HS", code: "ES", name: "España" },
  DE: { id: "A1PA6795UKMFR9", code: "DE", name: "Alemania" },
  FR: { id: "A13V1IB3VIYZZH", code: "FR", name: "Francia" },
  IT: { id: "APJ6JRA9NG5V4", code: "IT", name: "Italia" },
  UK: { id: "A1F83G8C2ARO7P", code: "UK", name: "Reino Unido" },
  NL: { id: "A1805IZSGTT6HS", code: "NL", name: "Países Bajos" },
  PL: { id: "A1C3SOZRARQ6R3", code: "PL", name: "Polonia" },
  SE: { id: "A2NODRKZP88ZB9", code: "SE", name: "Suecia" },
  BE: { id: "AMEN7PMS3EDWL", code: "BE", name: "Bélgica" },
};

export const ALL_EU_MARKETPLACE_IDS = Object.values(EU_MARKETPLACES).map((m) => m.id);

export function normalizeMarketplaceKey(input?: string): {
  normalizedKey: string;
  marketplaceId: string;
  isGlobal: boolean;
} {
  if (!input || input === "EU" || input === "global" || input === "ALL") {
    return { normalizedKey: "EU", marketplaceId: "EU", isGlobal: true };
  }
  const upper = input.toUpperCase().trim();
  if (EU_MARKETPLACES[upper]) {
    return { normalizedKey: upper, marketplaceId: EU_MARKETPLACES[upper].id, isGlobal: false };
  }
  const entry = Object.values(EU_MARKETPLACES).find((m) => m.id === upper);
  if (entry) {
    return { normalizedKey: entry.code, marketplaceId: entry.id, isGlobal: false };
  }
  return { normalizedKey: upper, marketplaceId: upper, isGlobal: false };
}

const CACHE_FILE = "account_health_snapshot.json";
const SNAPSHOTS_FILE = "account_health_snapshots.json";
const RAW_REPORT_FILE = "account_health_raw_all_eu.json";
const REPORT_TYPE = "GET_V2_SELLER_PERFORMANCE_REPORT";

const POLICY_DEFS: Array<{ key: string; title: string }> = [
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

export class AccountHealthService {
  private cache: Record<string, AccountHealthSnapshot> = {};
  private cacheTimestamps: Record<string, number> = {};
  private readonly CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos
  private inFlightRefresh: Promise<void> | null = null;

  constructor(private readonly client: SpApiClient, private readonly marketplaceIds: string[]) {
    this.tryLoadFromDisk();
  }

  /** Real customer feedback (1-2 stars + comment, last 365 days). "EU"/empty = every marketplace. */
  async getNegativeFeedback(marketplace?: string, force = false): Promise<SellerFeedbackItem[]> {
    const { normalizedKey, isGlobal } = normalizeMarketplaceKey(marketplace);
    const targets = isGlobal ? Object.values(EU_MARKETPLACES) : [EU_MARKETPLACES[normalizedKey]];
    if (targets.some((t) => !t)) throw new Error(`Marketplace desconocido: ${marketplace}`);
    // Request-time budget keeps the HTTP call under the socket timeout; the rest keeps loading into the cache.
    return fetchNegativeFeedback(this.client, targets, force, 150_000);
  }

  async getAccountHealth(marketplaceId?: string, forceRefresh = false): Promise<AccountHealthSnapshot> {
    const { normalizedKey } = normalizeMarketplaceKey(marketplaceId);
    const now = Date.now();

    if (
      !forceRefresh &&
      this.cache[normalizedKey] &&
      now - (this.cacheTimestamps[normalizedKey] || 0) < this.CACHE_TTL_MS
    ) {
      return { ...this.cache[normalizedKey], cached: true };
    }

    // Si ya hay una solicitud en curso, esperar a que termine
    if (this.inFlightRefresh) {
      try {
        await this.inFlightRefresh;
        if (this.cache[normalizedKey]) {
          return { ...this.cache[normalizedKey], cached: true };
        }
      } catch {
        // En caso de error, continuar abajo
      }
    }

    try {
      this.inFlightRefresh = this.refreshAllMarketplaces();
      await this.inFlightRefresh;
    } catch (err) {
      // Si falla la llamada en vivo, usar caché existente si existe
      if (this.cache[normalizedKey]) {
        return { ...this.cache[normalizedKey], cached: true };
      }
      throw err;
    } finally {
      this.inFlightRefresh = null;
    }

    const result = this.cache[normalizedKey] || this.cache["EU"] || this.cache["global"];
    if (!result) {
      throw new Error(`No se encontraron métricas para el marketplace ${marketplaceId}`);
    }
    return { ...result, cached: false };
  }

  /**
   * Obtiene las valoraciones recientes de clientes (GET_SELLER_FEEDBACK_DATA).
   * Lee primero del archivo local guardado y opcionalmente complementa con reportes completados de SP-API.
   */
  public async fetchRecentCustomerFeedback(): Promise<CustomerFeedbackItem[]> {
    const feedbackMap: Record<string, CustomerFeedbackItem> = {};

    // 1. Cargar datos guardados previamente en disco
    const jsonPaths = [
      path.resolve(process.cwd(), "seller_feedback.json"),
      path.resolve(process.cwd(), "..", "seller_feedback.json"),
      path.resolve(process.cwd(), "backend", "seller_feedback.json"),
    ];

    for (const jp of jsonPaths) {
      if (fs.existsSync(jp)) {
        try {
          const raw = fs.readFileSync(jp, "utf-8");
          const items = JSON.parse(raw) as CustomerFeedbackItem[];
          for (const it of items) {
            if (it.orderId && !feedbackMap[it.orderId]) {
              feedbackMap[it.orderId] = it;
            }
          }
        } catch {
          // ignore
        }
      }
    }

    // 2. Intentar consultar el último informe completado en SP-API para nuevas valoraciones
    try {
      const resp = await getReports(this.client, {
        reportTypes: ["GET_SELLER_FEEDBACK_DATA"],
        processingStatuses: ["DONE"],
        pageSize: 5,
      });

      // Procesar solo los primeros 2 reportes para no agotar la cuota de getReportDocument
      for (const rep of (resp.reports || []).slice(0, 2)) {
        if (!rep.reportDocumentId) continue;
        try {
          const doc = await getReportDocument(this.client, rep.reportDocumentId);
          const buf = await downloadReportDocument(doc);
          const text = buf.toString("utf-8");
          const lines = text.split(/\r?\n/);
          if (lines.length <= 1) continue;

          for (const line of lines.slice(1)) {
            const parts = line.split("\t");
            if (parts.length >= 5) {
              const [date, ratingStr, comments, response, orderId, raterEmail] = parts;
              if (orderId && !feedbackMap[orderId.trim()]) {
                feedbackMap[orderId.trim()] = {
                  date: date.trim(),
                  rating: Number(ratingStr) || 1,
                  comments: comments.trim(),
                  response: response ? response.trim() : undefined,
                  orderId: orderId.trim(),
                  raterEmail: raterEmail ? raterEmail.trim() : undefined,
                };
              }
            }
          }
        } catch (docErr) {
          // Ignorar throttling o error individual de descarga
        }
      }
    } catch {
      // Ignorar si la API está throttled, ya tenemos la caché en disco
    }

    const list = Object.values(feedbackMap);
    // Ordenar por fecha descendente
    list.sort((a, b) => {
      const parseDate = (d: string) => {
        try {
          const [day, month, year] = d.split("/").map(Number);
          return new Date(year, month - 1, day).getTime();
        } catch {
          return 0;
        }
      };
      return parseDate(b.date) - parseDate(a.date);
    });

    // Guardar en disco para persistencia
    try {
      const savePath = path.resolve(process.cwd(), "seller_feedback.json");
      fs.writeFileSync(savePath, JSON.stringify(list, null, 2), "utf-8");
    } catch {
      // ignore
    }

    return list;
  }

  private async refreshAllMarketplaces(): Promise<void> {
    const rawData = await this.fetchLiveReport(ALL_EU_MARKETPLACE_IDS);
    this.processRawReport(rawData);
    this.saveToDisk(rawData);
  }

  private async fetchLiveReport(marketplaceIds: string[]): Promise<Record<string, unknown>> {
    const { reportId } = await createReport(this.client, {
      reportType: REPORT_TYPE,
      marketplaceIds,
    });

    const maxAttempts = 35;
    const pollIntervalMs = 2500;

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

  private processRawReport(data: Record<string, unknown>): void {
    const now = Date.now();
    const snapshotsByCode: Record<string, AccountHealthSnapshot> = {};

    // 1. Procesar cada marketplace individual
    for (const [code, info] of Object.entries(EU_MARKETPLACES)) {
      const snapshot = this.parseMarketplaceSnapshot(data, info.id, code);
      snapshotsByCode[code] = snapshot;
      this.cache[code] = snapshot;
      this.cache[info.id] = snapshot;
      this.cacheTimestamps[code] = now;
      this.cacheTimestamps[info.id] = now;
    }

    // 2. Construir snapshot global / EU consolidado
    const globalSnapshot = this.buildGlobalSnapshot(data, snapshotsByCode);
    this.cache["EU"] = globalSnapshot;
    this.cache["global"] = globalSnapshot;
    this.cacheTimestamps["EU"] = now;
    this.cacheTimestamps["global"] = now;
  }

  private parseMarketplaceSnapshot(
    data: Record<string, unknown>,
    marketplaceId: string,
    countryCode: string
  ): AccountHealthSnapshot {
    const accountStatuses = (data.accountStatuses as Array<Record<string, unknown>>) || [];
    const perfList = (data.performanceMetrics as Array<Record<string, unknown>>) || [];

    const pm = perfList.find((p) => p.marketplaceId === marketplaceId) || {};
    const accStatus = accountStatuses.find((s) => s.marketplaceId === marketplaceId) || {};
    const accountStatus = String(accStatus.status || "NORMAL");

    // AHR
    const ahrObj = (pm.accountHealthRating as Record<string, unknown>) || {};
    const ahrScore = Number(ahrObj.ahrScore) || 200;
    const ahrStatus = String(ahrObj.ahrStatus || (ahrScore >= 200 ? "GREAT" : "WARNED"));

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

    const lateShipRate = Number(lateShip.rate) || 0;
    const onTimeRate = Number(onTimeDeliv.rate) || (Number(onTimeDeliv.shipmentCountWithValidTracking) ? 1 : 1);
    const crRate = Number(cancelRate.rate) || 0;
    const idrRate = Number(invoiceDefect.rate) || 0;
    const vtrRate = Number(validTracking.rate) || 0;

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
        rate: lateShipRate,
        ratePercent: `${(lateShipRate * 100).toFixed(2)}%`,
        target: "< 4.00%",
        targetValue: 0.04,
        status: (lateShipRate < 0.04 ? "GOOD" : "BAD") as "GOOD" | "BAD",
        orderCount: Number(lateShip.orderCount) || 0,
        defectCount: Number(lateShip.lateShipmentCount) || 0,
        description: "Pedidos confirmados para envío después de la fecha límite prevista.",
      },
      onTimeDeliveryRate: {
        title: "Ratio de Entregas a Tiempo (OTDR)",
        rate: onTimeRate,
        ratePercent: `${(onTimeRate * 100).toFixed(1)}%`,
        target: "> 97.00%",
        targetValue: 0.97,
        status: (onTimeRate >= 0.97 ? "GOOD" : "BAD") as "GOOD" | "BAD",
        orderCount: Number(onTimeDeliv.shipmentCountWithValidTracking) || 0,
        defectCount:
          (Number(onTimeDeliv.shipmentCountWithValidTracking) || 0) -
          (Number(onTimeDeliv.onTimeDeliveryCount) || Number(onTimeDeliv.shipmentCountWithValidTracking) || 0),
        description: "Envíos con seguimiento entregados antes o en la fecha prevista de entrega.",
      },
      cancellationRate: {
        title: "Cancelaciones Previas al Envío (CR)",
        rate: crRate,
        ratePercent: `${(crRate * 100).toFixed(2)}%`,
        target: "< 2.50%",
        targetValue: 0.025,
        status: (crRate < 0.025 ? "GOOD" : "BAD") as "GOOD" | "BAD",
        orderCount: Number(cancelRate.orderCount) || 0,
        defectCount: Number(cancelRate.cancellationCount) || 0,
        description: "Pedidos cancelados por el vendedor antes de confirmar el envío.",
      },
      invoiceDefectRate: {
        title: "Ratio de Defectos en Facturación (IDR)",
        rate: idrRate,
        ratePercent: `${(idrRate * 100).toFixed(2)}%`,
        target: "< 5.00%",
        targetValue: 0.05,
        status: (idrRate < 0.05 ? "GOOD" : "BAD") as "GOOD" | "BAD",
        orderCount: Number(invoiceDefect.orderCount) || 0,
        defectCount: Number((invoiceDefect.invoiceDefect as Record<string, unknown>)?.count) || 0,
        description: "Facturas no subidas dentro del plazo establecido a clientes comerciales.",
      },
      validTrackingRate: {
        title: "Ratio de Seguimiento Válido (VTR)",
        rate: vtrRate,
        ratePercent: `${(vtrRate * 100).toFixed(1)}%`,
        target: "> 95.00%",
        targetValue: 0.95,
        status: (vtrRate >= 0.95 || Number(validTracking.shipmentCount) === 0 ? "GOOD" : "WARNING") as
          | "GOOD"
          | "WARNING",
        orderCount: Number(validTracking.shipmentCount) || 0,
        defectCount: 0,
        description: "Porcentaje de envíos con número de seguimiento reconocido por Amazon.",
      },
    };

    // Políticas de cumplimiento
    const policyCompliance: PolicyViolationItem[] = POLICY_DEFS.map((p) => {
      const obj = (pm[p.key] as Record<string, unknown>) || {};
      const count = Number(obj.defectsCount) || 0;
      return {
        key: p.key,
        title: p.title,
        count,
        status: count === 0 ? "GOOD" : "BAD",
        target: 0,
      };
    });

    // Negativas y defectos
    const negativeFeedbacks: NegativeFeedbackItem[] = [];
    const afnDefects = (afnObj.orderWithDefects as Record<string, unknown>) || {};
    const afnDefectList = Array.isArray(afnDefects?.defects) ? afnDefects.defects : [];
    for (const defect of (afnDefectList as unknown as Array<Record<string, unknown>>) || []) {
      negativeFeedbacks.push({
        orderId: String(defect.orderId || defect.pedidoId || ""),
        asin: String(defect.asin || defect.ASIN || ""),
        marketplaceId,
        feedbackDate: String(defect.feedbackDate || defect.fecha || ""),
        feedbackType: "NEGATIVE_FEEDBACK",
        defectCount: Number(defect.defectCount || defect.count || 1),
        title: String(defect.title || defect.descripcion || "Defecto en pedido"),
        description: String(defect.description || defect.descripcion || ""),
      });
    }

    const mfnDefects = (mfnObj.orderWithDefects as Record<string, unknown>) || {};
    const mfnDefectList = Array.isArray(mfnDefects?.defects) ? mfnDefects.defects : [];
    for (const defect of (mfnDefectList as unknown as Array<Record<string, unknown>>) || []) {
      negativeFeedbacks.push({
        orderId: String(defect.orderId || defect.pedidoId || ""),
        asin: String(defect.asin || defect.ASIN || ""),
        marketplaceId,
        feedbackDate: String(defect.feedbackDate || defect.fecha || ""),
        feedbackType: "NEGATIVE_FEEDBACK",
        defectCount: Number(defect.defectCount || defect.count || 1),
        title: String(defect.title || defect.descripcion || "Defecto en pedido"),
        description: String(defect.description || defect.descripcion || ""),
      });
    }

    return {
      accountStatus,
      marketplaceId: countryCode,
      ahr: {
        score: ahrScore,
        status: ahrStatus,
        maxScore: 1000,
      },
      metrics,
      policyCompliance,
      negativeFeedbacks,
      fetchedAt: new Date().toISOString(),
      cached: false,
    };
  }

  private buildGlobalSnapshot(
    data: Record<string, unknown>,
    snapshots: Record<string, AccountHealthSnapshot>
  ): AccountHealthSnapshot {
    const list = Object.values(snapshots);

    // Estado global: si alguno está DESACTIVADO, reportar riesgo máximo; si alguno está AT_RISK, reportar AT_RISK
    const hasDeactivated = list.some((s) => s.accountStatus === "DEACTIVATED");
    const hasAtRisk = list.some((s) => s.accountStatus === "AT_RISK");
    const accountStatus = hasDeactivated ? "DEACTIVATED" : hasAtRisk ? "AT_RISK" : "NORMAL";

    // Puntuación AHR europea (tomamos la de España o la más representativa)
    const esAhr = snapshots["ES"]?.ahr || { score: 254, status: "GREAT", maxScore: 1000 };

    // Consolidar métricas sumando pedidos y defectos
    const sumOrders = (fn: (s: AccountHealthSnapshot) => number) => list.reduce((acc, s) => acc + (fn(s) || 0), 0);

    const afnOrders = sumOrders((s) => s.metrics.odrAfn.orderCount || 0);
    const afnDefects = sumOrders((s) => s.metrics.odrAfn.defectCount || 0);
    const afnRate = afnOrders > 0 ? afnDefects / afnOrders : 0;

    const mfnOrders = sumOrders((s) => s.metrics.odrMfn.orderCount || 0);
    const mfnDefects = sumOrders((s) => s.metrics.odrMfn.defectCount || 0);
    const mfnRate = mfnOrders > 0 ? mfnDefects / mfnOrders : 0;

    const lsrOrders = sumOrders((s) => s.metrics.lateShipmentRate.orderCount || 0);
    const lsrDefects = sumOrders((s) => s.metrics.lateShipmentRate.defectCount || 0);
    const lsrRate = lsrOrders > 0 ? lsrDefects / lsrOrders : 0;

    const otdrOrders = sumOrders((s) => s.metrics.onTimeDeliveryRate.orderCount || 0);
    const otdrDefects = sumOrders((s) => s.metrics.onTimeDeliveryRate.defectCount || 0);
    const otdrRate = otdrOrders > 0 ? (otdrOrders - otdrDefects) / otdrOrders : 1;

    const crOrders = sumOrders((s) => s.metrics.cancellationRate.orderCount || 0);
    const crDefects = sumOrders((s) => s.metrics.cancellationRate.defectCount || 0);
    const crRate = crOrders > 0 ? crDefects / crOrders : 0;

    const idrOrders = sumOrders((s) => s.metrics.invoiceDefectRate.orderCount || 0);
    const idrDefects = sumOrders((s) => s.metrics.invoiceDefectRate.defectCount || 0);
    const idrRate = idrOrders > 0 ? idrDefects / idrOrders : 0;

    const vtrOrders = sumOrders((s) => s.metrics.validTrackingRate.orderCount || 0);

    const metrics = {
      odrAfn: {
        title: "Ratio de Defectos en Pedidos (FBA)",
        rate: afnRate,
        ratePercent: `${(afnRate * 100).toFixed(2)}%`,
        target: "< 1.00%",
        targetValue: 0.01,
        status: (afnRate < 0.01 ? "GOOD" : "BAD") as "GOOD" | "BAD",
        orderCount: afnOrders,
        defectCount: afnDefects,
        description: "Reclamaciones A a Z, valoraciones negativas y contracargos en toda Europa (FBA).",
      },
      odrMfn: {
        title: "Ratio de Defectos en Pedidos (FBM / Vendedor)",
        rate: mfnRate,
        ratePercent: `${(mfnRate * 100).toFixed(2)}%`,
        target: "< 1.00%",
        targetValue: 0.01,
        status: (mfnRate < 0.01 ? "GOOD" : "BAD") as "GOOD" | "BAD",
        orderCount: mfnOrders,
        defectCount: mfnDefects,
        description: "Defectos en pedidos con gestión logística propia en toda Europa.",
      },
      lateShipmentRate: {
        title: "Ratio de Envíos Tardíos (LSR)",
        rate: lsrRate,
        ratePercent: `${(lsrRate * 100).toFixed(2)}%`,
        target: "< 4.00%",
        targetValue: 0.04,
        status: (lsrRate < 0.04 ? "GOOD" : "BAD") as "GOOD" | "BAD",
        orderCount: lsrOrders,
        defectCount: lsrDefects,
        description: "Pedidos europeos confirmados para envío después de la fecha límite.",
      },
      onTimeDeliveryRate: {
        title: "Ratio de Entregas a Tiempo (OTDR)",
        rate: otdrRate,
        ratePercent: `${(otdrRate * 100).toFixed(1)}%`,
        target: "> 97.00%",
        targetValue: 0.97,
        status: (otdrRate >= 0.97 ? "GOOD" : "BAD") as "GOOD" | "BAD",
        orderCount: otdrOrders,
        defectCount: otdrDefects,
        description: "Envíos con seguimiento entregados antes o en la fecha prevista en Europa.",
      },
      cancellationRate: {
        title: "Cancelaciones Previas al Envío (CR)",
        rate: crRate,
        ratePercent: `${(crRate * 100).toFixed(2)}%`,
        target: "< 2.50%",
        targetValue: 0.025,
        status: (crRate < 0.025 ? "GOOD" : "BAD") as "GOOD" | "BAD",
        orderCount: crOrders,
        defectCount: crDefects,
        description: "Pedidos cancelados por el vendedor antes de confirmar el envío en toda Europa.",
      },
      invoiceDefectRate: {
        title: "Ratio de Defectos en Facturación (IDR)",
        rate: idrRate,
        ratePercent: `${(idrRate * 100).toFixed(2)}%`,
        target: "< 5.00%",
        targetValue: 0.05,
        status: (idrRate < 0.05 ? "GOOD" : "BAD") as "GOOD" | "BAD",
        orderCount: idrOrders,
        defectCount: idrDefects,
        description: "Facturas no subidas dentro del plazo a clientes comerciales en Europa.",
      },
      validTrackingRate: {
        title: "Ratio de Seguimiento Válido (VTR)",
        rate: 0,
        ratePercent: "0.0%",
        target: "> 95.00%",
        targetValue: 0.95,
        status: (vtrOrders === 0 ? "GOOD" : "WARNING") as "GOOD" | "WARNING",
        orderCount: vtrOrders,
        defectCount: 0,
        description: "Porcentaje de envíos con número de seguimiento reconocido en Europa.",
      },
    };

    // Consolidar políticas sumando defectos
    const policyCompliance: PolicyViolationItem[] = POLICY_DEFS.map((p) => {
      const count = list.reduce((acc, s) => {
        const item = s.policyCompliance.find((pol) => pol.key === p.key);
        return acc + (item?.count || 0);
      }, 0);
      return {
        key: p.key,
        title: p.title,
        count,
        status: count === 0 ? "GOOD" : "BAD",
        target: 0,
      };
    });

    // Consolidar feedback negativo de todos los países
    const negativeFeedbacks: NegativeFeedbackItem[] = list.flatMap((s) => s.negativeFeedbacks || []);

    return {
      accountStatus,
      marketplaceId: "EU",
      ahr: {
        score: esAhr.score,
        status: esAhr.status,
        maxScore: 1000,
      },
      metrics,
      policyCompliance,
      negativeFeedbacks,
      fetchedAt: new Date().toISOString(),
      cached: false,
    };
  }

  private tryLoadFromDisk(): void {
    const rawFile = path.resolve(process.cwd(), RAW_REPORT_FILE);
    const altRawFile = path.resolve(process.cwd(), "..", RAW_REPORT_FILE);
    const targetRaw = fs.existsSync(rawFile) ? rawFile : fs.existsSync(altRawFile) ? altRawFile : null;

    if (targetRaw) {
      try {
        const raw = fs.readFileSync(targetRaw, "utf-8");
        const parsed = JSON.parse(raw);
        this.processRawReport(parsed);
        return;
      } catch {
        // Continuar con snapshots
      }
    }

    const diskPath = path.resolve(process.cwd(), SNAPSHOTS_FILE);
    const altDiskPath = path.resolve(process.cwd(), "..", SNAPSHOTS_FILE);
    const target = fs.existsSync(diskPath) ? diskPath : fs.existsSync(altDiskPath) ? altDiskPath : null;

    if (target) {
      try {
        const raw = fs.readFileSync(target, "utf-8");
        const parsed = JSON.parse(raw) as { snapshots: Record<string, AccountHealthSnapshot> };
        if (parsed?.snapshots) {
          const now = Date.now();
          for (const [key, snap] of Object.entries(parsed.snapshots)) {
            this.cache[key] = snap;
            this.cacheTimestamps[key] = now;
          }
          return;
        }
      } catch {
        // ignore
      }
    }

    // Fallback al snapshot simple previo si no hay snapshots múltiples
    const legacyPath = path.resolve(process.cwd(), CACHE_FILE);
    if (fs.existsSync(legacyPath)) {
      try {
        const raw = fs.readFileSync(legacyPath, "utf-8");
        const parsed = JSON.parse(raw) as AccountHealthSnapshot;
        this.cache["global"] = parsed;
        this.cache["EU"] = parsed;
        this.cache["ES"] = parsed;
        this.cacheTimestamps["global"] = Date.now();
      } catch {
        // ignore
      }
    }
  }

  private saveToDisk(rawData: Record<string, unknown>): void {
    try {
      const rawPath = path.resolve(process.cwd(), RAW_REPORT_FILE);
      fs.writeFileSync(rawPath, JSON.stringify(rawData, null, 2), "utf-8");

      const snapshotsPath = path.resolve(process.cwd(), SNAPSHOTS_FILE);
      const toStore: Record<string, AccountHealthSnapshot> = {};
      for (const [code] of Object.entries(EU_MARKETPLACES)) {
        if (this.cache[code]) toStore[code] = this.cache[code];
      }
      if (this.cache["EU"]) toStore["EU"] = this.cache["EU"];
      fs.writeFileSync(snapshotsPath, JSON.stringify({ updatedAt: new Date().toISOString(), snapshots: toStore }, null, 2), "utf-8");

      // También guardar legacy CACHE_FILE para compatibilidad
      const legacyPath = path.resolve(process.cwd(), CACHE_FILE);
      fs.writeFileSync(legacyPath, JSON.stringify(this.cache["ES"] || this.cache["EU"], null, 2), "utf-8");
    } catch {
      // ignore
    }
  }
}
