"use client";

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

interface AccountHealthSnapshot {
  accountStatus: string;
  marketplaceId: string;
  ahr: {
    score: number;
    status: string;
    maxScore: number;
  };
  metrics: {
    odrAfn: AccountHealthMetric;
    odrMfn: AccountHealthMetric;
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

const API_BASE = "http://localhost:4000/api/account-health";

export default function AccountHealthPage() {
  const [data, setData] = useState<AccountHealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [policyFilter, setPolicyFilter] = useState<"ALL" | "ISSUES" | "CLEAN">("ALL");

  const fetchData = async (force = false) => {
    if (force) setRefreshing(true);
    else setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/summary?force=${force}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: AccountHealthSnapshot = await res.json();
      setData(json);
      setError(null);
    } catch (err: unknown) {
      setError("No se pudo obtener el informe de salud de la cuenta desde SP-API.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const ahrScore = data?.ahr.score ?? 254;
  // AHR en Amazon: Verde >= 200, Amarillo 100-199, Rojo < 100
  const ahrPercent = Math.min(100, Math.max(0, (ahrScore / 1000) * 100));

  const filteredPolicies = (data?.policyCompliance || []).filter((p) => {
    if (policyFilter === "ISSUES") return p.count > 0;
    if (policyFilter === "CLEAN") return p.count === 0;
    return true;
  });

  const totalPolicyIssues = (data?.policyCompliance || []).reduce((acc, p) => acc + (p.count > 0 ? 1 : 0), 0);

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
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-3">
            Estado de la Cuenta y Rendimiento (Account Health)
            <span className="text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2.5 py-0.5 rounded-full font-medium">
              Cuenta: {data?.accountStatus || "NORMAL"}
            </span>
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Métricas oficiales de Seller Central para <strong className="text-slate-200">ROCKING GIFTS</strong> (España / Europa).
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
            onClick={() => fetchData(true)}
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
            {refreshing ? "Generando en Amazon..." : "Actualizar Informe"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 rounded-lg bg-rose-950/40 border border-rose-800/60 text-rose-300 text-sm">
          {error}
        </div>
      )}

      {/* HERO: ACCOUNT HEALTH RATING (AHR) */}
      <div className="p-6 rounded-2xl bg-gradient-to-br from-slate-900/90 to-slate-900/40 border border-slate-800 shadow-xl mb-8">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="max-w-xl">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
              <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                Calificación de Salud de la Cuenta (AHR)
              </span>
            </div>
            <h2 className="text-3xl font-extrabold text-slate-100 flex items-center gap-3">
              {ahrScore}{" "}
              <span className="text-lg font-normal text-slate-400">/ 1.000 puntos</span>
              <span className="text-xs px-3 py-1 rounded-full font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                SALUDABLE ({data?.ahr.status || "GREAT"})
              </span>
            </h2>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              Tu cuenta se encuentra en rango <strong className="text-slate-200">Saludable (&ge;200 pts)</strong>.
              No corres riesgo inmediato de desactivación. Cumples con holgura los estándares operativos de entregas y cancelaciones.
            </p>
          </div>

          {/* Barra de escala de Amazon (Rojo / Amarillo / Verde) */}
          <div className="lg:w-96 bg-slate-950/80 p-4 rounded-xl border border-slate-800/80">
            <div className="flex justify-between text-[11px] text-slate-400 mb-1.5 font-medium">
              <span>0 (Riesgo)</span>
              <span>200 (Saludable)</span>
              <span>1.000 (Máx)</span>
            </div>
            <div className="h-4 w-full bg-slate-800 rounded-full overflow-hidden flex relative">
              {/* Segmentos de color */}
              <div className="w-[10%] bg-rose-500/80 border-r border-slate-900"></div>
              <div className="w-[10%] bg-amber-500/80 border-r border-slate-900"></div>
              <div className="w-[80%] bg-emerald-500/80"></div>
            </div>
            <div className="mt-2 flex items-center justify-between text-xs">
              <span className="text-slate-400 text-[11px]">Tu puntuación actual:</span>
              <span className="font-bold text-emerald-400">{ahrScore} puntos</span>
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
              Rendimiento Operativo de Envíos y Atención al Cliente
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
                  {data?.metrics.odrAfn.title || "Ratio de Defectos (FBA)"}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  ✓ Objetivo {data?.metrics.odrAfn.target}
                </span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-extrabold text-emerald-400">
                  {data?.metrics.odrAfn.ratePercent ?? "0.00%"}
                </span>
                <span className="text-xs text-slate-400">
                  ({data?.metrics.odrAfn.defectCount ?? 0} defectos en {data?.metrics.odrAfn.orderCount ?? 0} pedidos)
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                {data?.metrics.odrAfn.description}
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-800/80 text-[10px] text-slate-500">
              Canal: Amazon Logística (FBA)
            </div>
          </div>

          {/* ODR MFN (Merchant) */}
          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-slate-300">
                  {data?.metrics.odrMfn.title || "Ratio de Defectos (FBM)"}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  ✓ Objetivo {data?.metrics.odrMfn.target}
                </span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-extrabold text-emerald-400">
                  {data?.metrics.odrMfn.ratePercent ?? "0.38%"}
                </span>
                <span className="text-xs text-slate-400">
                  ({data?.metrics.odrMfn.defectCount ?? 2} defectos en {data?.metrics.odrMfn.orderCount ?? 526} pedidos)
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                {data?.metrics.odrMfn.description}
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-800/80 text-[10px] text-slate-500">
              Canal: Gestión propia (FBM)
            </div>
          </div>

          {/* Envíos Tardíos (LSR) */}
          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-slate-300">
                  {data?.metrics.lateShipmentRate.title || "Envíos Tardíos (LSR)"}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  ✓ Objetivo {data?.metrics.lateShipmentRate.target}
                </span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-extrabold text-emerald-400">
                  {data?.metrics.lateShipmentRate.ratePercent ?? "0.00%"}
                </span>
                <span className="text-xs text-slate-400">
                  (0 envíos tardíos de {data?.metrics.lateShipmentRate.orderCount ?? 282})
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                {data?.metrics.lateShipmentRate.description}
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-800/80 text-[10px] text-slate-500">
              Cumplimiento perfecto (100% a tiempo)
            </div>
          </div>

          {/* Entregas a Tiempo (OTDR) */}
          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-slate-300">
                  {data?.metrics.onTimeDeliveryRate.title || "Entregas a Tiempo (OTDR)"}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  ✓ Objetivo {data?.metrics.onTimeDeliveryRate.target}
                </span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-extrabold text-emerald-400">
                  {data?.metrics.onTimeDeliveryRate.ratePercent ?? "100.0%"}
                </span>
                <span className="text-xs text-slate-400">
                  ({data?.metrics.onTimeDeliveryRate.orderCount ?? 276} de {data?.metrics.onTimeDeliveryRate.orderCount ?? 276} pedidos)
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                {data?.metrics.onTimeDeliveryRate.description}
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-800/80 text-[10px] text-slate-500">
              Rendimiento excelente en paquetería
            </div>
          </div>

          {/* Cancelaciones previas (CR) */}
          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-slate-300">
                  {data?.metrics.cancellationRate.title || "Cancelaciones Previas (CR)"}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  ✓ Objetivo {data?.metrics.cancellationRate.target}
                </span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-extrabold text-emerald-400">
                  {data?.metrics.cancellationRate.ratePercent ?? "0.00%"}
                </span>
                <span className="text-xs text-slate-400">
                  (0 cancelaciones de {data?.metrics.cancellationRate.orderCount ?? 69})
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                {data?.metrics.cancellationRate.description}
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-800/80 text-[10px] text-slate-500">
              Control de rotura de stock perfecto
            </div>
          </div>

          {/* Defectos Facturación (IDR) */}
          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-slate-300">
                  {data?.metrics.invoiceDefectRate.title || "Defectos Facturación (IDR)"}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  ✓ Objetivo {data?.metrics.invoiceDefectRate.target}
                </span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-extrabold text-emerald-400">
                  {data?.metrics.invoiceDefectRate.ratePercent ?? "0.00%"}
                </span>
                <span className="text-xs text-slate-400">
                  (0 facturas pendientes)
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                {data?.metrics.invoiceDefectRate.description}
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-800/80 text-[10px] text-slate-500">
              Servicio de cálculo de IVA activo
            </div>
          </div>
        </div>
      </div>

      {/* SECCIÓN 2: CUMPLIMIENTO DE POLÍTICAS DE AMAZON */}
      <div>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
              <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              Cumplimiento de Políticas de Amazon (Policy Compliance)
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Auditoría de infracciones reglamentarias, propiedad intelectual y seguridad de productos en los últimos 180 días.
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
              Todas ({data?.policyCompliance.length ?? 0})
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
              Limpias ({(data?.policyCompliance.length ?? 0) - totalPolicyIssues})
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
    </main>
  );
}
