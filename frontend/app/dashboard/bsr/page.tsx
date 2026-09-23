"use client";

import { API_ORIGIN } from "@/lib/apiBase";
import React, { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Bar,
} from "recharts";
import { usePrivacy } from "@/lib/PrivacyContext";

const API_URL = API_ORIGIN;

export interface BsrRankInfo {
  id?: string;
  title: string;
  rank: number;
  link?: string;
}

export interface ProductBsrOverview {
  asin: string;
  sku: string;
  name: string;
  rootCategory?: BsrRankInfo | null;
  detailCategory?: BsrRankInfo | null;
  lastUpdated: string;
  totalSales30d?: number;
}

export interface BsrHistoryPoint {
  date: string;
  rootRank: number | null;
  detailRank: number | null;
  unitsSold: number;
  rootCategoryTitle?: string;
  detailCategoryTitle?: string;
}

export interface ProductBsrHistoryResult {
  asin: string;
  sku: string;
  name: string;
  current: {
    rootCategory?: BsrRankInfo | null;
    detailCategory?: BsrRankInfo | null;
    lastUpdated: string;
  };
  history: BsrHistoryPoint[];
  stats: {
    bestRootRank: number | null;
    worstRootRank: number | null;
    bestDetailRank: number | null;
    worstDetailRank: number | null;
    currentRootRank: number | null;
    currentDetailRank: number | null;
  };
}

const numberFormat = (val: number | null | undefined) =>
  val !== null && val !== undefined ? `#${val.toLocaleString("es-ES")}` : "-";

const shortDate = (iso: string) => {
  try {
    const d = new Date(`${iso}T00:00:00Z`);
    return d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", timeZone: "UTC" });
  } catch {
    return iso;
  }
};

const fullDisplayDate = (iso: string) => {
  try {
    const d = new Date(`${iso}T00:00:00Z`);
    return d.toLocaleDateString("es-ES", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
};

interface TooltipPayloadEntry {
  dataKey: string;
  name: string;
  value: number;
  payload: BsrHistoryPoint;
}

function BsrChartTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayloadEntry[] }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-950/95 p-3.5 text-xs shadow-2xl backdrop-blur max-w-xs space-y-2">
      <p className="font-bold text-slate-200 border-b border-slate-800 pb-1.5">
        {fullDisplayDate(point.date)}
      </p>

      {/* Detail Category Rank */}
      <div className="flex items-center justify-between gap-4">
        <span className="text-emerald-400 font-medium flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />
          {point.detailCategoryTitle || "Subcategoría"}:
        </span>
        <span className="font-bold text-slate-100 font-mono">
          {numberFormat(point.detailRank)}
        </span>
      </div>

      {/* Root Category Rank */}
      <div className="flex items-center justify-between gap-4">
        <span className="text-indigo-400 font-medium flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-indigo-400 inline-block" />
          {point.rootCategoryTitle || "Cat. Principal"}:
        </span>
        <span className="font-bold text-slate-100 font-mono">
          {numberFormat(point.rootRank)}
        </span>
      </div>

      {/* Units Sold */}
      <div className="pt-1.5 border-t border-slate-800 flex items-center justify-between text-slate-400">
        <span>Ventas registradas ese día:</span>
        <span className="font-semibold text-slate-200">
          {point.unitsSold} {point.unitsSold === 1 ? "unidad" : "unidades"}
        </span>
      </div>
    </div>
  );
}

export default function BsrDashboardPage() {
  const { isPrivacyMode, maskProductName, maskSku, maskAsin } = usePrivacy();
  const [catalog, setCatalog] = useState<ProductBsrOverview[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [selectedAsin, setSelectedAsin] = useState<string>("");
  const [historyDays, setHistoryDays] = useState<number>(60);
  const [productHistory, setProductHistory] = useState<ProductBsrHistoryResult | null>(null);
  const [historyLoading, setHistoryLoading] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  // Filter toggles
  const [showRoot, setShowRoot] = useState<boolean>(true);
  const [showDetail, setShowDetail] = useState<boolean>(true);
  const [showSalesBars, setShowSalesBars] = useState<boolean>(true);

  // Table search
  const [searchFilter, setSearchFilter] = useState<string>("");

  // 1. Load catalog overview
  useEffect(() => {
    setCatalogLoading(true);
    fetch(`${API_URL}/api/bsr/catalog`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: ProductBsrOverview[]) => {
        setCatalog(data);
        if (data.length > 0 && !selectedAsin) {
          // Preselect product with highest sales or first with rank
          const preferred =
            data.find((p) => p.detailCategory?.rank || p.rootCategory?.rank) || data[0];
          setSelectedAsin(preferred.asin);
        }
      })
      .catch((err) => setCatalogError(err instanceof Error ? err.message : "Error cargando catálogo"))
      .finally(() => setCatalogLoading(false));
  }, []);

  // 2. Load history for selected ASIN
  useEffect(() => {
    if (!selectedAsin) return;
    setHistoryLoading(true);

    fetch(`${API_URL}/api/bsr/history/${encodeURIComponent(selectedAsin)}?days=${historyDays}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: ProductBsrHistoryResult) => {
        setProductHistory(data);
      })
      .catch((err) => console.error("Error cargando historial BSR:", err))
      .finally(() => setHistoryLoading(false));
  }, [selectedAsin, historyDays]);

  // Handle live refresh
  const handleRefreshLive = async () => {
    if (!selectedAsin) return;
    setRefreshing(true);
    try {
      const res = await fetch(`${API_URL}/api/bsr/refresh/${encodeURIComponent(selectedAsin)}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Re-fetch history to update view
      const histRes = await fetch(
        `${API_URL}/api/bsr/history/${encodeURIComponent(selectedAsin)}?days=${historyDays}`
      );
      if (histRes.ok) {
        const histData = await histRes.json();
        setProductHistory(histData);
      }
    } catch (err) {
      alert("No se pudo conectar con Amazon SP-API para refrescar en vivo.");
    } finally {
      setRefreshing(false);
    }
  };

  const selectedProduct = useMemo(() => {
    return catalog.find((p) => p.asin === selectedAsin) || null;
  }, [catalog, selectedAsin]);

  const filteredCatalog = useMemo(() => {
    if (!searchFilter.trim()) return catalog;
    const term = searchFilter.toLowerCase();
    return catalog.filter(
      (p) =>
        p.name.toLowerCase().includes(term) ||
        p.sku.toLowerCase().includes(term) ||
        p.asin.toLowerCase().includes(term) ||
        p.rootCategory?.title?.toLowerCase().includes(term) ||
        p.detailCategory?.title?.toLowerCase().includes(term)
    );
  }, [catalog, searchFilter]);

  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pb-6 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
              <span className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-lg">
                🏆
              </span>
              Monitorización de BSR (Best Sellers Rank)
            </h1>
            <span className="text-xs px-2.5 py-1 rounded-full font-medium border bg-emerald-500/10 text-emerald-400 border-emerald-500/30 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              General + Detail Category
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Evolución temporal del ranking de ventas de Amazon tanto en el departamento principal como en su subcategoría nicho.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleRefreshLive}
            disabled={refreshing || !selectedAsin}
            className="rounded-lg border border-indigo-500/40 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 px-3.5 py-2 text-xs font-semibold transition-colors flex items-center gap-2 disabled:opacity-50"
          >
            <span className={`text-sm ${refreshing ? "animate-spin" : ""}`}>🔄</span>
            <span>{refreshing ? "Consultando Amazon..." : "Actualizar BSR en Vivo"}</span>
          </button>
        </div>
      </div>

      {catalogError && (
        <div className="p-4 rounded-lg bg-red-950/40 border border-red-800 text-red-300 text-sm">
          Error: {catalogError}
        </div>
      )}

      {/* Product Selector Bar */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 w-full sm:w-auto">
          <label htmlFor="asin-select" className="text-xs font-semibold uppercase tracking-wider text-slate-400 shrink-0">
            Producto a analizar:
          </label>
          <select
            id="asin-select"
            value={selectedAsin}
            onChange={(e) => setSelectedAsin(e.target.value)}
            disabled={catalogLoading}
            className="w-full sm:w-96 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
          >
            {catalog.map((p) => {
              const displaySku = maskSku(p.sku);
              const displayName = maskProductName(p.name, p.sku);
              return (
                <option key={p.asin} value={p.asin}>
                  {displaySku} — {displayName.slice(0, 50)}...
                </option>
              );
            })}
          </select>
        </div>

        {selectedProduct && (
          <div className="text-xs text-slate-400 flex items-center gap-3">
            <span className="font-mono text-slate-300 bg-slate-950 px-2 py-1 rounded border border-slate-800">
              ASIN: {maskAsin(selectedProduct.asin)}
            </span>
            <span className="font-mono text-slate-300 bg-slate-950 px-2 py-1 rounded border border-slate-800">
              SKU: {maskSku(selectedProduct.sku)}
            </span>
          </div>
        )}
      </div>

      {/* KPI Cards Grid for Selected Product */}
      {productHistory && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Card 1: Detail Category */}
          <div className="rounded-xl border border-emerald-500/20 bg-slate-900/50 p-5 relative overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-emerald-500 to-emerald-500/0" />
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-emerald-400 flex items-center gap-1.5">
                <span>🏆</span> Subcategoría (Detail Category)
              </span>
              {productHistory.current.detailCategory?.link && (
                <a
                  href={productHistory.current.detailCategory.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-emerald-400/80 hover:text-emerald-300 underline"
                >
                  Ver en Amazon ↗
                </a>
              )}
            </div>
            <p className="mt-2 text-2xl font-bold font-mono text-slate-100">
              {numberFormat(productHistory.current.detailCategory?.rank)}
            </p>
            <p className="mt-1 text-xs text-slate-300 font-medium truncate">
              {productHistory.current.detailCategory?.title || "Sin ranking en subcategoría"}
            </p>
            <div className="mt-3 pt-3 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
              <span>Mejor: <strong className="text-emerald-300 font-mono">{numberFormat(productHistory.stats.bestDetailRank)}</strong></span>
              <span>Peor: <strong className="text-slate-400 font-mono">{numberFormat(productHistory.stats.worstDetailRank)}</strong></span>
            </div>
          </div>

          {/* Card 2: General / Root Category */}
          <div className="rounded-xl border border-indigo-500/20 bg-slate-900/50 p-5 relative overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-indigo-500 to-indigo-500/0" />
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-indigo-400 flex items-center gap-1.5">
                <span>🏷️</span> Categoría General (Root)
              </span>
              {productHistory.current.rootCategory?.link && (
                <a
                  href={productHistory.current.rootCategory.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-indigo-400/80 hover:text-indigo-300 underline"
                >
                  Ver en Amazon ↗
                </a>
              )}
            </div>
            <p className="mt-2 text-2xl font-bold font-mono text-slate-100">
              {numberFormat(productHistory.current.rootCategory?.rank)}
            </p>
            <p className="mt-1 text-xs text-slate-300 font-medium truncate">
              {productHistory.current.rootCategory?.title || "Sin ranking general"}
            </p>
            <div className="mt-3 pt-3 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
              <span>Mejor: <strong className="text-indigo-300 font-mono">{numberFormat(productHistory.stats.bestRootRank)}</strong></span>
              <span>Peor: <strong className="text-slate-400 font-mono">{numberFormat(productHistory.stats.worstRootRank)}</strong></span>
            </div>
          </div>

          {/* Card 3: Velocity & Context */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 relative overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-amber-500/60 to-amber-500/0" />
            <span className="text-xs font-medium uppercase tracking-wide text-amber-400 flex items-center gap-1.5">
              <span>📦</span> Tracción de Ventas
            </span>
            <p className="mt-2 text-2xl font-bold text-slate-100">
              {selectedProduct?.totalSales30d ?? 0}{" "}
              <span className="text-xs font-normal text-slate-400">uds en últimos 30 días</span>
            </p>
            <p className="mt-1 text-xs text-slate-400">
              Un mayor volumen de pedidos diarios impulsa el BSR hacia puestos más altos (#1 = más vendido).
            </p>
            <div className="mt-3 pt-3 border-t border-slate-800/80 text-[11px] text-slate-500">
              Última lectura: {new Date(productHistory.current.lastUpdated).toLocaleDateString("es-ES")}
            </div>
          </div>
        </div>
      )}

      {/* Main BSR Evolution Chart */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 shadow-sm space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-200">
              Evolución Temporal del BSR
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              Comparativa de ambas curvas a lo largo del tiempo. (Los puestos más bajos indican mayor éxito en ventas).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Range Selector */}
            <div className="inline-flex rounded-lg border border-slate-800 bg-slate-950 p-1 text-xs">
              {[14, 30, 60, 90].map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => setHistoryDays(days)}
                  className={`rounded-md px-3 py-1 font-medium transition-colors ${
                    historyDays === days
                      ? "bg-indigo-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {days}d
                </button>
              ))}
            </div>

            {/* Visibility Toggles */}
            <label className="flex items-center gap-1.5 text-xs text-emerald-400 cursor-pointer bg-slate-950 px-2.5 py-1.5 rounded-lg border border-slate-800">
              <input
                type="checkbox"
                checked={showDetail}
                onChange={(e) => setShowDetail(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-emerald-600 cursor-pointer"
              />
              <span>Subcategoría</span>
            </label>

            <label className="flex items-center gap-1.5 text-xs text-indigo-400 cursor-pointer bg-slate-950 px-2.5 py-1.5 rounded-lg border border-slate-800">
              <input
                type="checkbox"
                checked={showRoot}
                onChange={(e) => setShowRoot(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-indigo-600 cursor-pointer"
              />
              <span>Cat. General</span>
            </label>

            <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer bg-slate-950 px-2.5 py-1.5 rounded-lg border border-slate-800">
              <input
                type="checkbox"
                checked={showSalesBars}
                onChange={(e) => setShowSalesBars(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-slate-600 cursor-pointer"
              />
              <span>Ventas diarias</span>
            </label>
          </div>
        </div>

        {historyLoading && (
          <div className="flex items-center justify-center gap-3 py-24 text-slate-400">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-indigo-400" />
            <span className="text-sm">Cargando serie temporal de BSR...</span>
          </div>
        )}

        {!historyLoading && productHistory && (
          <div className="h-80 sm:h-96 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={productHistory.history}
                margin={{ top: 12, right: 16, left: 0, bottom: 0 }}
              >
                <CartesianGrid vertical={false} stroke="#1e293b" />
                <XAxis
                  dataKey="date"
                  tickFormatter={shortDate}
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={{ stroke: "#1e293b" }}
                  tickLine={false}
                />

                {/* Left Y-Axis: Detail Category Rank (Reversed so #1 is top!) */}
                <YAxis
                  yAxisId="left"
                  orientation="left"
                  reversed
                  tick={{ fill: "#10b981", fontSize: 11 }}
                  axisLine={{ stroke: "#065f46" }}
                  tickLine={false}
                  tickFormatter={(val: number) => `#${val}`}
                  width={55}
                  domain={["dataMin - 10", "dataMax + 20"]}
                />

                {/* Right Y-Axis: Root Category Rank (Reversed so #1 is top!) */}
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  reversed
                  tick={{ fill: "#6366f1", fontSize: 11 }}
                  axisLine={{ stroke: "#312e81" }}
                  tickLine={false}
                  tickFormatter={(val: number) => `#${val >= 1000 ? `${Math.round(val / 1000)}k` : val}`}
                  width={55}
                  domain={["dataMin - 500", "dataMax + 1000"]}
                />

                {/* Hidden Y-Axis for Sales Bars */}
                <YAxis yAxisId="sales" orientation="right" hide domain={[0, "dataMax + 8"]} />

                <Tooltip content={<BsrChartTooltip />} cursor={{ stroke: "rgba(99,102,241,0.2)", strokeWidth: 1 }} />
                <Legend
                  verticalAlign="top"
                  align="right"
                  wrapperStyle={{ paddingBottom: 12, fontSize: 11 }}
                  formatter={(val) => {
                    if (val === "detailRank") return "BSR Subcategoría (Eje Izquierdo)";
                    if (val === "rootRank") return "BSR Cat. General (Eje Derecho)";
                    if (val === "unitsSold") return "Unidades Vendidas";
                    return val;
                  }}
                />

                {/* Optional background sales bars */}
                {showSalesBars && (
                  <Bar
                    yAxisId="sales"
                    dataKey="unitsSold"
                    name="unitsSold"
                    fill="#334155"
                    opacity={0.4}
                    radius={[2, 2, 0, 0]}
                    maxBarSize={12}
                  />
                )}

                {/* Detail Category Curve */}
                {showDetail && (
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="detailRank"
                    name="detailRank"
                    stroke="#10b981"
                    strokeWidth={2.5}
                    dot={{ fill: "#10b981", r: 2 }}
                    activeDot={{ r: 5, stroke: "#34d399", strokeWidth: 2 }}
                  />
                )}

                {/* Root Category Curve */}
                {showRoot && (
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="rootRank"
                    name="rootRank"
                    stroke="#6366f1"
                    strokeWidth={2}
                    strokeDasharray="4 2"
                    dot={{ fill: "#6366f1", r: 2 }}
                    activeDot={{ r: 5, stroke: "#818cf8", strokeWidth: 2 }}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Catalog Table: All Products BSR Overview */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-200">
              Ranking BSR de Todo el Catálogo
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              Listado de productos con sus dos categorías y rankings registrados.
            </p>
          </div>

          <div className="relative w-full sm:w-72">
            <input
              type="text"
              placeholder="Buscar por SKU, ASIN, título o categoría..."
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 pl-8 text-xs text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
            <span className="absolute left-2.5 top-2 text-slate-500 text-xs">🔍</span>
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/40">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-800 bg-slate-950 text-slate-400 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-2.5 px-4">Producto</th>
                <th className="py-2.5 px-4">Subcategoría (Detail Category)</th>
                <th className="py-2.5 px-4">Categoría General</th>
                <th className="py-2.5 px-4 text-right">Ventas 30d</th>
                <th className="py-2.5 px-4 text-center">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filteredCatalog.map((prod) => {
                const isSelected = selectedAsin === prod.asin;
                const displaySku = maskSku(prod.sku);
                const displayAsin = maskAsin(prod.asin);
                const displayName = maskProductName(prod.name, prod.sku);

                return (
                  <tr
                    key={prod.asin}
                    className={`transition-colors ${
                      isSelected ? "bg-indigo-950/30 border-l-4 border-indigo-500" : "hover:bg-slate-800/30"
                    }`}
                  >
                    <td className="py-2.5 px-4">
                      <div className="font-medium text-slate-200 line-clamp-1" title={displayName}>
                        {displayName}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-[11px] font-mono text-slate-400">
                        <span className="text-indigo-400">{displaySku}</span>
                        <span>ASIN: {displayAsin}</span>
                      </div>
                    </td>

                    {/* Detail Category Column */}
                    <td className="py-2.5 px-4">
                      {prod.detailCategory ? (
                        <div>
                          <span className="font-bold text-emerald-400 font-mono text-sm">
                            {numberFormat(prod.detailCategory.rank)}
                          </span>
                          <div className="text-[11px] text-slate-400 line-clamp-1">
                            {prod.detailCategory.title}
                          </div>
                        </div>
                      ) : (
                        <span className="text-slate-500 italic">No disponible</span>
                      )}
                    </td>

                    {/* Root Category Column */}
                    <td className="py-2.5 px-4">
                      {prod.rootCategory ? (
                        <div>
                          <span className="font-semibold text-indigo-300 font-mono">
                            {numberFormat(prod.rootCategory.rank)}
                          </span>
                          <div className="text-[11px] text-slate-400 line-clamp-1">
                            {prod.rootCategory.title}
                          </div>
                        </div>
                      ) : (
                        <span className="text-slate-500 italic">No disponible</span>
                      )}
                    </td>

                    {/* Sales 30d */}
                    <td className="py-2.5 px-4 text-right font-medium text-slate-300">
                      {prod.totalSales30d ?? 0} uds
                    </td>

                    {/* Action Button */}
                    <td className="py-2.5 px-4 text-center">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedAsin(prod.asin);
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }}
                        className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                          isSelected
                            ? "bg-indigo-600 text-white"
                            : "bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white"
                        }`}
                      >
                        {isSelected ? "Activo" : "Ver Gráfico"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
