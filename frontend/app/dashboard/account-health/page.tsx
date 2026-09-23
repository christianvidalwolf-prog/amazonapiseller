"use client";

import { API_ORIGIN } from "@/lib/apiBase";
import { useEffect, useState } from "react";
import Link from "next/link";

interface AccountHealthMetric {
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

interface PolicyViolationItem {
  key: string;
  title: string;
  count: number;
  status: "GOOD" | "BAD";
  target: number;
}

export interface SellerFeedbackItem {
  date: string;
  rating: number;
  comments: string;
  response?: string;
  orderId: string;
  raterEmail?: string;
}

interface AccountHealthSnapshot {
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
  customerFeedback?: SellerFeedbackItem[];
  fetchedAt: string;
  cached: boolean;
}

interface NegativeFeedbackItem {
  orderId: string;
  asin: string;
  marketplaceId: string;
  feedbackDate: string;
  feedbackType: "NEGATIVE_FEEDBACK" | "A_Z_CLAIM" | "CHARGEBACK" | "LISTING_VIOLATION";
  defectCount: number;
  title: string;
  description: string;
  marketplaceCode?: string;
  rating?: number;
  sellerResponse?: string;
}

const MARKETPLACE_OPTIONS = [
  { value: "EU", label: "Global / Todos los marketplaces (Europa)", country: "Europa" },
  { value: "ES", label: "Amazon.es (España)", country: "España" },
  { value: "DE", label: "Amazon.de (Alemania)", country: "Alemania" },
  { value: "FR", label: "Amazon.fr (Francia)", country: "Francia" },
  { value: "IT", label: "Amazon.it (Italia)", country: "Italia" },
  { value: "UK", label: "Amazon.co.uk (Reino Unido)", country: "Reino Unido" },
  { value: "PL", label: "Amazon.pl (Polonia)", country: "Polonia" },
  { value: "NL", label: "Amazon.nl (Países Bajos)", country: "Países Bajos" },
  { value: "SE", label: "Amazon.se (Suecia)", country: "Suecia" },
  { value: "BE", label: "Amazon.be (Bélgica)", country: "Bélgica" },
];

const API_BASE = `${API_ORIGIN}/api/account-health`;

export default function AccountHealthPage() {
  const [data, setData] = useState<AccountHealthSnapshot | null>(null);
  const [feedbackList, setFeedbackList] = useState<SellerFeedbackItem[]>([]);
  const [loadingFeedback, setLoadingFeedback] = useState(false);
  const [feedbackRatingFilter, setFeedbackRatingFilter] = useState<"ALL" | "NEGATIVE" | "NEUTRAL">("ALL");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [policyFilter, setPolicyFilter] = useState<"ALL" | "ISSUES" | "CLEAN">("ALL");
  const [negatives, setNegatives] = useState<NegativeFeedbackItem[]>([]);
  const [negativesLoading, setNegativesLoading] = useState(false);
  const [selectedMarketplace, setSelectedMarketplace] = useState<string>("EU");

  const loadData = async (marketplace: string, force = false) => {
    if (force) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      // Customer feedback can take minutes (Amazon throttles that report), so it loads independently of the metrics.
      setNegativesLoading(true);
      fetch(`${API_BASE}/negatives?marketplaceId=${encodeURIComponent(marketplace)}&force=${force}`)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((json: NegativeFeedbackItem[]) => setNegatives(json))
        .catch(() => setNegatives([]))
        .finally(() => setNegativesLoading(false));

      const summaryRes = await fetch(`${API_BASE}/summary?marketplaceId=${encodeURIComponent(marketplace)}&force=${force}`);

      if (!summaryRes.ok) {
        throw new Error(`HTTP ${summaryRes.status}`);
      }

      const summaryJson: AccountHealthSnapshot = await summaryRes.json();
      setData(summaryJson);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`No se pudo obtener el informe de salud para ${marketplace} (${msg}).`);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadData(selectedMarketplace, false);
  }, [selectedMarketplace]);

  const currentOption = MARKETPLACE_OPTIONS.find((m) => m.value === selectedMarketplace) || MARKETPLACE_OPTIONS[0];

  const ahrScore = data?.ahr?.score ?? 200;
  const ahrPercent = Math.min(100, Math.max(0, (ahrScore / 1000) * 100));

  const isDeactivated = data?.accountStatus === "DEACTIVATED";
  const isAtRisk = data?.accountStatus === "AT_RISK" || ahrScore < 200;

  const filteredPolicies = (data?.policyCompliance || []).filter((p) => {
    if (policyFilter === "ISSUES") return p.count > 0;
    if (policyFilter === "CLEAN") return p.count === 0;
    return true;
  });

  const totalPolicyIssues = (data?.policyCompliance || []).reduce((acc, p) => acc + (p.count > 0 ? 1 : 0), 0);
  const totalViolationsCount = (data?.policyCompliance || []).reduce((acc, p) => acc + (p.count || 0), 0);

  return (
    <main className="max-w-7xl mx-auto px-6 py-8">
      {/* Cabecera */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-800 pb-6 mb-8">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Link href="/" className="text-xs text-slate-400 hover:text-slate-200">
              Inicio
            </Link>
            <span className="text-xs text-slate-600">/</span>
            <span className="text-xs text-emerald-400 font-medium">Salud y Rendimiento</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-100">
              Estado de la Cuenta y Rendimiento (Account Health)
            </h1>
            <span
              className={`text-xs px-2.5 py-0.5 rounded-full font-bold border transition-colors ${
                isDeactivated
                  ? "bg-rose-500/15 text-rose-400 border-rose-500/30"
                  : isAtRisk
                  ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
                  : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
              }`}
            >
              Cuenta: {isDeactivated ? "DESACTIVADA" : isAtRisk ? "EN RIESGO (AT RISK)" : "NORMAL"}
            </span>
          </div>

          <div className="flex items-center gap-3 mt-3">
            <label htmlFor="marketplace-select" className="text-xs text-slate-400 font-medium">
              Marketplace:
            </label>
            <select
              id="marketplace-select"
              value={selectedMarketplace}
              onChange={(e) => setSelectedMarketplace(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all cursor-pointer hover:border-slate-600"
            >
              {MARKETPLACE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            {loading && !refreshing && (
              <span className="text-xs text-indigo-400 animate-pulse flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Cargando {currentOption.country}...
              </span>
            )}
          </div>

          <p className="text-sm text-slate-400 mt-2">
            Métricas oficiales auditadas por Seller Central para <strong className="text-slate-200">ROCKING GIFTS</strong> ({currentOption.label}).
          </p>
        </div>

        {/* Botón Actualizar */}
        <div className="flex items-center gap-3">
          {data?.fetchedAt && (
            <span className="text-xs text-slate-500">
              Último informe: {new Date(data.fetchedAt).toLocaleTimeString("es-ES")}
            </span>
          )}
          <button
            onClick={() => loadData(selectedMarketplace, true)}
            disabled={refreshing || loading}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-all flex items-center gap-2 shadow-sm disabled:opacity-50"
          >
            <svg
              className={`w-3.5 h-3.5 ${refreshing ? "animate-spin text-amber-300" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {refreshing ? "Sincronizando con Amazon..." : "Actualizar Informe"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 rounded-lg bg-rose-950/40 border border-rose-800/60 text-rose-300 text-sm flex items-center justify-between">
          <span>{error}</span>
          <button
            onClick={() => loadData(selectedMarketplace, true)}
            className="text-xs underline text-rose-200 hover:text-white"
          >
            Reintentar
          </button>
        </div>
      )}

      {/* HERO: ACCOUNT HEALTH RATING (AHR) */}
      <div className="p-6 rounded-2xl bg-gradient-to-br from-slate-900/90 to-slate-900/40 border border-slate-800 shadow-xl mb-8">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="max-w-xl">
            <div className="flex items-center gap-2 mb-2">
              <span
                className={`w-2.5 h-2.5 rounded-full animate-pulse ${
                  isDeactivated ? "bg-rose-400" : isAtRisk ? "bg-amber-400" : "bg-emerald-400"
                }`}
              ></span>
              <span
                className={`text-xs font-semibold uppercase tracking-wider ${
                  isDeactivated ? "text-rose-400" : isAtRisk ? "text-amber-400" : "text-emerald-400"
                }`}
              >
                Calificación de Salud de la Cuenta (AHR) - {currentOption.country}
              </span>
            </div>
            <h2 className="text-3xl font-extrabold text-slate-100 flex items-center gap-3">
              {ahrScore}{" "}
              <span className="text-lg font-normal text-slate-400">/ 1.000 puntos</span>
              <span
                className={`text-xs px-3 py-1 rounded-full font-bold border ${
                  isDeactivated
                    ? "bg-rose-500/20 text-rose-300 border-rose-500/30"
                    : isAtRisk
                    ? "bg-amber-500/20 text-amber-300 border-amber-500/30"
                    : "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                }`}
              >
                {isDeactivated
                  ? "DESACTIVADA"
                  : isAtRisk
                  ? `EN RIESGO (${data?.ahr?.status || "WARNED"})`
                  : `SALUDABLE (${data?.ahr?.status || "GREAT"})`}
              </span>
            </h2>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              {isDeactivated ? (
                <>
                  La cuenta se encuentra <strong className="text-rose-300">desactivada</strong> en {currentOption.country}.
                  Es prioritario apelar las infracciones de políticas para restablecer la venta.
                </>
              ) : isAtRisk ? (
                <>
                  Tu cuenta se encuentra en rango <strong className="text-amber-300">En Riesgo (&lt;200 pts o estado AT_RISK)</strong> en {currentOption.country}.
                  Existe riesgo de restricción de privilegios si no se resuelven las advertencias de catálogo y políticas.
                </>
              ) : (
                <>
                  Tu cuenta se encuentra en rango <strong className="text-emerald-300">Saludable (&ge;200 pts)</strong> en {currentOption.country}.
                  Cumples con los estándares operativos de entregas y cancelaciones.
                </>
              )}
            </p>
          </div>

          {/* Barra de escala de Amazon (Rojo / Amarillo / Verde) */}
          <div className="lg:w-96 bg-slate-950/80 p-4 rounded-xl border border-slate-800/80">
            <div className="flex justify-between text-[11px] text-slate-400 mb-1.5 font-medium">
              <span className="text-rose-400">0 (Riesgo)</span>
              <span className="text-amber-400">100 - 199</span>
              <span className="text-emerald-400">200 - 1.000 (Saludable)</span>
            </div>
            <div className="h-4 w-full bg-slate-800 rounded-full overflow-hidden flex relative">
              {/* Segmentos de color: 0-100 (10%), 100-200 (10%), 200-1000 (80%) */}
              <div className="w-[10%] bg-rose-500/80 border-r border-slate-900" title="Riesgo crítico (<100)"></div>
              <div className="w-[10%] bg-amber-500/80 border-r border-slate-900" title="En riesgo (100-199)"></div>
              <div className="w-[80%] bg-emerald-500/80" title="Saludable (200-1000)"></div>

              {/* Marcador de puntuación actual */}
              <div
                className="absolute top-0 bottom-0 w-1.5 bg-white shadow-md rounded-full transform -translate-x-1/2 border border-slate-900"
                style={{ left: `${Math.max(2, Math.min(98, ahrPercent))}%` }}
                title={`Puntuación actual: ${ahrScore}`}
              ></div>
            </div>
            <div className="mt-2 flex items-center justify-between text-xs">
              <span className="text-slate-400 text-[11px]">Puntuación en {currentOption.country}:</span>
              <span
                className={`font-bold ${
                  isDeactivated ? "text-rose-400" : isAtRisk ? "text-amber-400" : "text-emerald-400"
                }`}
              >
                {ahrScore} puntos ({data?.ahr?.status || (ahrScore >= 200 ? "GREAT" : "WARNED")})
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* SECCIÓN 1: RENDIMIENTO DEL SERVICIO AL CLIENTE Y ENVÍOS */}
      <div className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
              <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Rendimiento Operativo de Envíos y Atención al Cliente ({currentOption.country})
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Métricas auditadas por Amazon frente a los objetivos obligatorios para mantener los privilegios de venta.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* ODR AFN (FBA) */}
          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-slate-300">
                  {data?.metrics?.odrAfn?.title || "Ratio de Defectos (FBA)"}
                </span>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded font-bold border ${
                    (data?.metrics?.odrAfn?.status || "GOOD") === "GOOD"
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                      : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                  }`}
                >
                  ✓ Objetivo {data?.metrics?.odrAfn?.target || "< 1.00%"}
                </span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span
                  className={`text-2xl font-extrabold ${
                    (data?.metrics?.odrAfn?.status || "GOOD") === "GOOD" ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {data?.metrics?.odrAfn?.ratePercent ?? "0.00%"}
                </span>
                <span className="text-xs text-slate-400">
                  ({data?.metrics?.odrAfn?.defectCount ?? 0} defectos en {data?.metrics?.odrAfn?.orderCount ?? 0} pedidos)
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                {data?.metrics?.odrAfn?.description || "Reclamaciones de la A a la Z, valoraciones negativas y contracargos gestionados por Amazon FBA."}
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-800/80 text-[10px] text-slate-500">
              Canal: Amazon Logística (FBA) - {currentOption.country}
            </div>
          </div>

          {/* ODR MFN (Merchant) */}
          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-slate-300">
                  {data?.metrics?.odrMfn?.title || "Ratio de Defectos (FBM)"}
                </span>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded font-bold border ${
                    (data?.metrics?.odrMfn?.status || "GOOD") === "GOOD"
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                      : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                  }`}
                >
                  ✓ Objetivo {data?.metrics?.odrMfn?.target || "< 1.00%"}
                </span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span
                  className={`text-2xl font-extrabold ${
                    (data?.metrics?.odrMfn?.status || "GOOD") === "GOOD" ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {data?.metrics?.odrMfn?.ratePercent ?? "0.00%"}
                </span>
                <span className="text-xs text-slate-400">
                  ({data?.metrics?.odrMfn?.defectCount ?? 0} defectos en {data?.metrics?.odrMfn?.orderCount ?? 0} pedidos)
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                {data?.metrics?.odrMfn?.description || "Defectos en pedidos con gestión logística propia."}
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-800/80 text-[10px] text-slate-500">
              Canal: Gestión propia (FBM) - {currentOption.country}
            </div>
          </div>

          {/* Envíos Tardíos (LSR) */}
          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-slate-300">
                  {data?.metrics?.lateShipmentRate?.title || "Envíos Tardíos (LSR)"}
                </span>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded font-bold border ${
                    (data?.metrics?.lateShipmentRate?.status || "GOOD") === "GOOD"
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                      : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                  }`}
                >
                  ✓ Objetivo {data?.metrics?.lateShipmentRate?.target || "< 4.00%"}
                </span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span
                  className={`text-2xl font-extrabold ${
                    (data?.metrics?.lateShipmentRate?.status || "GOOD") === "GOOD"
                      ? "text-emerald-400"
                      : "text-rose-400"
                  }`}
                >
                  {data?.metrics?.lateShipmentRate?.ratePercent ?? "0.00%"}
                </span>
                <span className="text-xs text-slate-400">
                  ({data?.metrics?.lateShipmentRate?.defectCount ?? 0} tardíos de {data?.metrics?.lateShipmentRate?.orderCount ?? 0} pedidos)
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                {data?.metrics?.lateShipmentRate?.description || "Pedidos confirmados para envío después de la fecha límite prevista."}
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-800/80 text-[10px] text-slate-500">
              {Number(data?.metrics?.lateShipmentRate?.defectCount ?? 0) === 0
                ? "Cumplimiento perfecto (100% a tiempo)"
                : `${data?.metrics?.lateShipmentRate?.defectCount} envíos con retraso registrado`}
            </div>
          </div>

          {/* Entregas a Tiempo (OTDR) */}
          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-slate-300">
                  {data?.metrics?.onTimeDeliveryRate?.title || "Entregas a Tiempo (OTDR)"}
                </span>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded font-bold border ${
                    (data?.metrics?.onTimeDeliveryRate?.status || "GOOD") === "GOOD"
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                      : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                  }`}
                >
                  ✓ Objetivo {data?.metrics?.onTimeDeliveryRate?.target || "> 97.00%"}
                </span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span
                  className={`text-2xl font-extrabold ${
                    (data?.metrics?.onTimeDeliveryRate?.status || "GOOD") === "GOOD"
                      ? "text-emerald-400"
                      : "text-rose-400"
                  }`}
                >
                  {data?.metrics?.onTimeDeliveryRate?.ratePercent ?? "100.0%"}
                </span>
                <span className="text-xs text-slate-400">
                  ({Math.max(0, (data?.metrics?.onTimeDeliveryRate?.orderCount ?? 0) - (data?.metrics?.onTimeDeliveryRate?.defectCount ?? 0))} de {data?.metrics?.onTimeDeliveryRate?.orderCount ?? 0} pedidos)
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                {data?.metrics?.onTimeDeliveryRate?.description || "Envíos con seguimiento entregados antes o en la fecha prevista de entrega."}
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-800/80 text-[10px] text-slate-500">
              Rendimiento en paquetería
            </div>
          </div>

          {/* Cancelaciones previas (CR) */}
          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-slate-300">
                  {data?.metrics?.cancellationRate?.title || "Cancelaciones Previas (CR)"}
                </span>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded font-bold border ${
                    (data?.metrics?.cancellationRate?.status || "GOOD") === "GOOD"
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                      : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                  }`}
                >
                  ✓ Objetivo {data?.metrics?.cancellationRate?.target || "< 2.50%"}
                </span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span
                  className={`text-2xl font-extrabold ${
                    (data?.metrics?.cancellationRate?.status || "GOOD") === "GOOD"
                      ? "text-emerald-400"
                      : "text-rose-400"
                  }`}
                >
                  {data?.metrics?.cancellationRate?.ratePercent ?? "0.00%"}
                </span>
                <span className="text-xs text-slate-400">
                  ({data?.metrics?.cancellationRate?.defectCount ?? 0} cancelaciones de {data?.metrics?.cancellationRate?.orderCount ?? 0} pedidos)
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                {data?.metrics?.cancellationRate?.description || "Pedidos cancelados por el vendedor antes de confirmar el envío."}
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-800/80 text-[10px] text-slate-500">
              Control de rotura de stock
            </div>
          </div>

          {/* Defectos Facturación (IDR) */}
          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-slate-300">
                  {data?.metrics?.invoiceDefectRate?.title || "Defectos Facturación (IDR)"}
                </span>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded font-bold border ${
                    (data?.metrics?.invoiceDefectRate?.status || "GOOD") === "GOOD"
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                      : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                  }`}
                >
                  ✓ Objetivo {data?.metrics?.invoiceDefectRate?.target || "< 5.00%"}
                </span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span
                  className={`text-2xl font-extrabold ${
                    (data?.metrics?.invoiceDefectRate?.status || "GOOD") === "GOOD"
                      ? "text-emerald-400"
                      : "text-rose-400"
                  }`}
                >
                  {data?.metrics?.invoiceDefectRate?.ratePercent ?? "0.00%"}
                </span>
                <span className="text-xs text-slate-400">
                  ({data?.metrics?.invoiceDefectRate?.defectCount ?? 0} facturas pendientes de {data?.metrics?.invoiceDefectRate?.orderCount ?? 0})
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                {data?.metrics?.invoiceDefectRate?.description || "Facturas no subidas dentro del plazo establecido a clientes comerciales."}
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-800/80 text-[10px] text-slate-500">
              Servicio de cálculo de IVA
            </div>
          </div>
        </div>
      </div>

      {/* SECCIÓN 2: CUMPLIMIENTO DE POLÍTICAS DE AMAZON */}
      <div className="mb-10">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
              <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              Cumplimiento de Políticas de Amazon (Policy Compliance) - {currentOption.country}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Auditoría de infracciones reglamentarias, propiedad intelectual y seguridad de productos en los últimos 180 días ({totalViolationsCount} avisos en total).
            </p>
          </div>

          {/* Filtro de Políticas */}
          <div className="flex items-center gap-1 bg-slate-900/80 p-1 rounded-xl border border-slate-800 text-xs">
            <button
              onClick={() => setPolicyFilter("ALL")}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                policyFilter === "ALL" ? "bg-indigo-600 text-white shadow" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Todas ({data?.policyCompliance?.length ?? 0})
            </button>
            <button
              onClick={() => setPolicyFilter("ISSUES")}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
                policyFilter === "ISSUES" ? "bg-amber-600 text-white shadow" : "text-slate-400 hover:text-amber-300"
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
              Con Avisos ({totalPolicyIssues})
            </button>
            <button
              onClick={() => setPolicyFilter("CLEAN")}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
                policyFilter === "CLEAN" ? "bg-emerald-600 text-white shadow" : "text-slate-400 hover:text-emerald-300"
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
              Limpias ({(data?.policyCompliance?.length ?? 0) - totalPolicyIssues})
            </button>
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/40">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950/80 text-slate-400 uppercase tracking-wider border-b border-slate-800">
              <tr>
                <th className="px-4 py-3">Política Reglamentaria de Amazon</th>
                <th className="px-4 py-3 text-center">Objetivo</th>
                <th className="px-4 py-3 text-center">Defectos Detectados</th>
                <th className="px-4 py-3 text-right">Estado de Cumplimiento</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filteredPolicies.map((pol) => (
                <tr key={pol.key} className="hover:bg-slate-800/30 transition-colors">
                  <td className="px-4 py-3 font-medium text-slate-200">
                    {pol.title}
                  </td>
                  <td className="px-4 py-3 text-center font-mono text-slate-400">
                    {pol.target}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`font-bold px-2 py-0.5 rounded text-xs ${
                        pol.count === 0
                          ? "text-emerald-400 bg-emerald-500/10"
                          : "text-amber-300 bg-amber-500/10 border border-amber-500/20"
                      }`}
                    >
                      {pol.count}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {pol.count === 0 ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                        Conforme (0 avisos)
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                        {pol.count} avisos registrados
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* SECCIÓN 3: VALORACIONES NEGATIVAS RECIENTES */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
              <svg className="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 6l-6-6m6 6l6-6" />
              </svg>
              Valoraciones y Comentarios Negativos Recientes ({currentOption.country})
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Valoraciones de 1-2 estrellas con el comentario del cliente, últimos 12 meses.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">
              Total: {negatives.length}
            </span>
          </div>
        </div>

        {negativesLoading && negatives.length === 0 ? (
          <div className="p-6 rounded-xl bg-slate-900/60 border border-slate-800 text-slate-400 text-center">
            <p className="text-sm">Descargando valoraciones desde Amazon… Amazon limita este informe (≈1 por minuto y país), puede tardar varios minutos la primera vez.</p>
          </div>
        ) : negatives.length === 0 ? (
          <div className="p-6 rounded-xl bg-slate-900/60 border border-slate-800 text-slate-400 text-center">
            <p className="text-sm">No hay valoraciones negativas ni reclamaciones registradas para {currentOption.country}.</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/40">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="bg-slate-950/80 text-slate-400 uppercase tracking-wider border-b border-slate-800">
                <tr>
                  <th className="px-4 py-3">Fecha</th>
                  <th className="px-4 py-3">País</th>
                  <th className="px-4 py-3">Pedido</th>
                  <th className="px-4 py-3 text-center">Valoración</th>
                  <th className="px-4 py-3">Comentario del cliente</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {negatives.map((fb, idx) => (
                  <tr key={`${fb.orderId}-${idx}`} className="align-top hover:bg-slate-800/30 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap text-slate-300">{fb.feedbackDate || "-"}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-400">{fb.marketplaceCode ?? "-"}</td>
                    <td className="px-4 py-3 whitespace-nowrap font-mono text-slate-200">{fb.orderId || "N/A"}</td>
                    <td className="px-4 py-3 text-center whitespace-nowrap">
                      <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/20">
                        {fb.rating ? `${fb.rating} ★` : fb.feedbackType}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[11px] leading-relaxed text-slate-200">
                      <p className="whitespace-pre-wrap break-words max-w-2xl">{fb.description || fb.title || "Sin comentario"}</p>
                      {fb.sellerResponse && (
                        <p className="mt-1 text-slate-400 max-w-2xl">
                          <span className="font-semibold text-slate-300">Tu respuesta:</span> {fb.sellerResponse}
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
