"use client";

import { useEffect, useMemo, useState } from "react";
import { API_ORIGIN } from "@/lib/apiBase";

interface AdMetrics {
  impressions: number;
  clicks: number;
  cost: number;
  sales: number;
  orders: number;
  cpc: number;
  ctr: number;
  acos: number;
  roas: number;
}

interface AdCampaign {
  campaignId: string;
  name: string;
  campaignType: "sponsoredProducts" | "sponsoredBrands" | "sponsoredDisplay";
  targetingType?: "manual" | "auto";
  state: "enabled" | "paused" | "archived";
  dailyBudget: number;
  startDate?: string;
  endDate?: string;
  metrics: AdMetrics;
}

interface AdvertisingSummary {
  isConnected: boolean;
  profileId?: string;
  marketplace: string;
  currency: string;
  totalCampaigns: number;
  activeCampaigns: number;
  metrics: {
    spend: number;
    attributedSales: number;
    totalStoreSales: number;
    clicks: number;
    impressions: number;
    cpc: number;
    ctr: number;
    acos: number;
    roas: number;
    tacos: number;
  };
  period: {
    start: string;
    end: string;
  };
  isDemoData?: boolean;
  message?: string;
}

const API_BASE = API_ORIGIN;

export default function AdvertisingDashboard() {
  const [summary, setSummary] = useState<AdvertisingSummary | null>(null);
  const [campaigns, setCampaigns] = useState<AdCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Filters
  const [statusFilter, setStatusFilter] = useState<"ALL" | "enabled" | "paused">("ALL");
  const [typeFilter, setTypeFilter] = useState<"ALL" | "sponsoredProducts" | "sponsoredBrands" | "sponsoredDisplay">("ALL");
  const [searchQuery, setSearchQuery] = useState("");

  const fetchData = async () => {
    try {
      setError(null);
      const [sumRes, campRes] = await Promise.all([
        fetch(`${API_BASE}/api/advertising/summary`),
        fetch(`${API_BASE}/api/advertising/campaigns`),
      ]);

      if (!sumRes.ok || !campRes.ok) {
        throw new Error("No se pudieron cargar los datos de publicidad.");
      }

      const sumData = (await sumRes.json()) as AdvertisingSummary;
      const campData = (await campRes.json()) as { campaigns: AdCampaign[] };

      setSummary(sumData);
      setCampaigns(campData.campaigns || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchData();
  };

  const filteredCampaigns = useMemo(() => {
    return campaigns.filter((c) => {
      if (statusFilter !== "ALL" && c.state !== statusFilter) return false;
      if (typeFilter !== "ALL" && c.campaignType !== typeFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return c.name.toLowerCase().includes(q) || c.campaignId.toLowerCase().includes(q);
      }
      return true;
    });
  }, [campaigns, statusFilter, typeFilter, searchQuery]);

  const organicSales = useMemo(() => {
    if (!summary) return 0;
    return Math.max(0, summary.metrics.totalStoreSales - summary.metrics.attributedSales);
  }, [summary]);

  const ppcSalesPercent = useMemo(() => {
    if (!summary || summary.metrics.totalStoreSales <= 0) return 0;
    return Math.min(100, (summary.metrics.attributedSales / summary.metrics.totalStoreSales) * 100);
  }, [summary]);

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
              <span className="p-1.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 text-lg">
                📢
              </span>
              Publicidad & Amazon Ads (PPC)
            </h1>
            {summary && (
              <span
                className={`text-xs px-2.5 py-1 rounded-full font-medium border flex items-center gap-1.5 ${
                  summary.isConnected
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                    : "bg-amber-500/10 text-amber-400 border-amber-500/30"
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    summary.isConnected ? "bg-emerald-400 animate-pulse" : "bg-amber-400"
                  }`}
                />
                {summary.isConnected ? "Ads API Conectada" : "Modo Asistido / Demo"}
              </span>
            )}
          </div>
          <p className="text-sm text-slate-400 mt-1">
            Rendimiento de campañas Sponsored Products, Brands y Display con cálculo de TACoS unificado.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {summary?.profileId && (
            <div className="text-xs text-slate-400 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-md">
              <span className="text-slate-500">Perfil Ads:</span> {summary.profileId} ({summary.marketplace})
            </div>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="px-3.5 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md transition-colors border border-slate-700 flex items-center gap-2 disabled:opacity-50"
          >
            <span className={refreshing ? "animate-spin" : ""}>🔄</span>
            {refreshing ? "Actualizando..." : "Actualizar"}
          </button>
        </div>
      </div>

      {/* Notice Banner if in demo mode / auth pending */}
      {summary?.isDemoData && (
        <div className="mt-6 p-4 rounded-xl bg-gradient-to-r from-amber-950/40 to-slate-900 border border-amber-500/30 text-slate-200">
          <div className="flex items-start gap-3">
            <span className="text-2xl">⚡</span>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-amber-300">
                Conexión con Amazon Ads API pendiente de vincular
              </h3>
              <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                Estás visualizando las métricas estimadas y el cálculo de TACoS real cruzado con tus ventas de la tienda.
                Para conectar tu cuenta de publicidad en vivo mediante la API directa:
              </p>
              <div className="mt-3 p-2.5 bg-slate-950/80 rounded-lg border border-slate-800 font-mono text-xs text-emerald-400 flex items-center justify-between">
                <span>python3 backend/scripts/ads_auth_helper.py</span>
                <span className="text-slate-500 text-[11px] font-sans">
                  Ejecuta este asistente en tu terminal para obtener el token de Ads en 1 minuto
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="py-20 text-center">
          <div className="inline-block w-8 h-8 border-4 border-amber-400 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-sm text-slate-400 mt-4">Consultando métricas de publicidad...</p>
        </div>
      ) : error ? (
        <div className="mt-6 p-4 rounded-lg bg-red-950/50 border border-red-800 text-red-300 text-sm">
          {error}
        </div>
      ) : summary ? (
        <>
          {/* Main KPI Cards Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-6">
            {/* TACoS (The Star Metric) */}
            <div className="p-5 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-slate-700 transition-all relative overflow-hidden group">
              <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-amber-500 to-emerald-500" />
              <div className="flex justify-between items-start">
                <span className="text-xs font-medium text-slate-400">TACoS (Total ACoS)</span>
                <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                  {summary.metrics.tacos <= 10 ? "Excelente" : summary.metrics.tacos <= 15 ? "Óptimo" : "Vigilar"}
                </span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-3xl font-bold text-slate-100">{summary.metrics.tacos}%</span>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Gasto PPC vs Ventas Totales ({summary.metrics.totalStoreSales.toLocaleString("es-ES")} €)
              </p>
            </div>

            {/* ACoS */}
            <div className="p-5 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-slate-700 transition-all">
              <div className="flex justify-between items-start">
                <span className="text-xs font-medium text-slate-400">ACoS (Ad Cost of Sales)</span>
                <span className="text-xs px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium">
                  ROAS {summary.metrics.roas}x
                </span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-3xl font-bold text-slate-100">{summary.metrics.acos}%</span>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Gasto sobre ventas atribuidas a anuncios
              </p>
            </div>

            {/* Spend & Sales */}
            <div className="p-5 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-slate-700 transition-all">
              <div className="flex justify-between items-start">
                <span className="text-xs font-medium text-slate-400">Gasto PPC (Spend)</span>
                <span className="text-xs text-slate-500">Últimos 30 días</span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-3xl font-bold text-amber-400">
                  {summary.metrics.spend.toLocaleString("es-ES", { minimumFractionDigits: 2 })} €
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Generó {summary.metrics.attributedSales.toLocaleString("es-ES", { minimumFractionDigits: 2 })} € en ventas PPC
              </p>
            </div>

            {/* Clicks & CPC */}
            <div className="p-5 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-slate-700 transition-all">
              <div className="flex justify-between items-start">
                <span className="text-xs font-medium text-slate-400">Tráfico & Coste Clic</span>
                <span className="text-xs text-slate-500">CTR {summary.metrics.ctr}%</span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-3xl font-bold text-slate-100">
                  {summary.metrics.clicks.toLocaleString("es-ES")}
                </span>
                <span className="text-xs text-slate-400">clics</span>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                CPC medio: <span className="text-slate-300 font-medium">{summary.metrics.cpc} €</span> | {summary.metrics.impressions.toLocaleString("es-ES")} impresiones
              </p>
            </div>
          </div>

          {/* Revenue Attribution Breakdown: Organic vs PPC */}
          <div className="mt-6 p-6 rounded-xl bg-slate-900/80 border border-slate-800">
            <h2 className="text-sm font-semibold text-slate-200 mb-4 flex items-center justify-between">
              <span>Atribución de Ingresos: Orgánico vs Publicidad (PPC)</span>
              <span className="text-xs font-normal text-slate-400">
                Total Tienda: {summary.metrics.totalStoreSales.toLocaleString("es-ES")} €
              </span>
            </h2>

            {/* Visual Bar */}
            <div className="w-full h-4 bg-slate-800 rounded-full overflow-hidden flex">
              <div
                style={{ width: `${100 - ppcSalesPercent}%` }}
                className="bg-emerald-500 h-full transition-all duration-500"
                title={`Ventas Orgánicas: ${(100 - ppcSalesPercent).toFixed(1)}%`}
              />
              <div
                style={{ width: `${ppcSalesPercent}%` }}
                className="bg-amber-500 h-full transition-all duration-500"
                title={`Ventas PPC: ${ppcSalesPercent.toFixed(1)}%`}
              />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-4 text-xs">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-emerald-500 inline-block" />
                <span className="text-slate-400">Ventas Orgánicas:</span>
                <span className="font-semibold text-slate-200">
                  {organicSales.toLocaleString("es-ES", { minimumFractionDigits: 2 })} € ({(100 - ppcSalesPercent).toFixed(1)}%)
                </span>
              </div>

              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-amber-500 inline-block" />
                <span className="text-slate-400">Ventas Atribuidas PPC:</span>
                <span className="font-semibold text-slate-200">
                  {summary.metrics.attributedSales.toLocaleString("es-ES", { minimumFractionDigits: 2 })} € ({ppcSalesPercent.toFixed(1)}%)
                </span>
              </div>

              <div className="flex items-center gap-2 sm:justify-end">
                <span className="text-slate-400">Ratio Orgánico / PPC:</span>
                <span className="font-semibold text-emerald-400">
                  {ppcSalesPercent > 0 ? ((100 - ppcSalesPercent) / ppcSalesPercent).toFixed(1) : "0"} : 1
                </span>
              </div>
            </div>
          </div>

          {/* Campaigns Section */}
          <div className="mt-8">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-100">Campañas Publicitarias</h2>
                <p className="text-xs text-slate-400">
                  {filteredCampaigns.length} de {campaigns.length} campañas mostradas
                </p>
              </div>

              {/* Filters */}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  placeholder="Buscar campaña..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500 w-48"
                />

                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as any)}
                  className="px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-200 focus:outline-none focus:border-amber-500"
                >
                  <option value="ALL">Todos los Estados</option>
                  <option value="enabled">Activas</option>
                  <option value="paused">Pausadas</option>
                </select>

                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value as any)}
                  className="px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-200 focus:outline-none focus:border-amber-500"
                >
                  <option value="ALL">Todos los Tipos</option>
                  <option value="sponsoredProducts">Sponsored Products</option>
                  <option value="sponsoredBrands">Sponsored Brands</option>
                  <option value="sponsoredDisplay">Sponsored Display</option>
                </select>
              </div>
            </div>

            {/* Campaigns Table */}
            <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60 shadow-xl">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-slate-950/80 text-slate-400 font-semibold uppercase tracking-wider border-b border-slate-800">
                  <tr>
                    <th className="px-4 py-3.5">Campaña</th>
                    <th className="px-4 py-3.5">Tipo & Segmentación</th>
                    <th className="px-4 py-3.5">Estado</th>
                    <th className="px-4 py-3.5 text-right">Presupuesto/Día</th>
                    <th className="px-4 py-3.5 text-right">Clics</th>
                    <th className="px-4 py-3.5 text-right">CPC</th>
                    <th className="px-4 py-3.5 text-right">Gasto</th>
                    <th className="px-4 py-3.5 text-right">Ventas PPC</th>
                    <th className="px-4 py-3.5 text-right">ACoS</th>
                    <th className="px-4 py-3.5 text-right">ROAS</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filteredCampaigns.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-4 py-8 text-center text-slate-500">
                        No se encontraron campañas con los filtros seleccionados.
                      </td>
                    </tr>
                  ) : (
                    filteredCampaigns.map((camp) => {
                      const typeLabel =
                        camp.campaignType === "sponsoredProducts"
                          ? "SP"
                          : camp.campaignType === "sponsoredBrands"
                          ? "SB"
                          : "SD";
                      const typeBadge =
                        camp.campaignType === "sponsoredProducts"
                          ? "bg-sky-500/10 text-sky-400 border-sky-500/30"
                          : camp.campaignType === "sponsoredBrands"
                          ? "bg-purple-500/10 text-purple-400 border-purple-500/30"
                          : "bg-indigo-500/10 text-indigo-400 border-indigo-500/30";

                      return (
                        <tr key={camp.campaignId} className="hover:bg-slate-800/40 transition-colors">
                          <td className="px-4 py-3 font-medium text-slate-100">
                            <div>{camp.name}</div>
                            <span className="text-[10px] text-slate-500 font-mono">{camp.campaignId}</span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${typeBadge}`}>
                                {typeLabel}
                              </span>
                              <span className="text-slate-400 capitalize">
                                {camp.targetingType || "auto"}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                                camp.state === "enabled"
                                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                                  : "bg-slate-800 text-slate-400 border border-slate-700"
                              }`}
                            >
                              {camp.state === "enabled" ? "Activa" : "Pausada"}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-slate-200">
                            {camp.dailyBudget.toFixed(2)} €
                          </td>
                          <td className="px-4 py-3 text-right text-slate-300">
                            {camp.metrics.clicks.toLocaleString("es-ES")}
                          </td>
                          <td className="px-4 py-3 text-right text-slate-300">
                            {camp.metrics.cpc.toFixed(2)} €
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-amber-400">
                            {camp.metrics.cost.toFixed(2)} €
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-emerald-400">
                            {camp.metrics.sales.toFixed(2)} €
                          </td>
                          <td className="px-4 py-3 text-right font-semibold">
                            <span
                              className={`px-2 py-0.5 rounded text-[11px] ${
                                camp.metrics.acos <= 15
                                  ? "bg-emerald-500/10 text-emerald-400"
                                  : camp.metrics.acos <= 25
                                  ? "bg-amber-500/10 text-amber-400"
                                  : "bg-rose-500/10 text-rose-400"
                              }`}
                            >
                              {camp.metrics.acos.toFixed(1)}%
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-slate-300">
                            {camp.metrics.roas.toFixed(2)}x
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}
    </main>
  );
}
