"use client";

import { API_ORIGIN } from "@/lib/apiBase";
import React, { useEffect, useMemo, useRef, useState } from "react";
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
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  // Filter toggles
  const [showRoot, setShowRoot] = useState<boolean>(true);
  const [showDetail, setShowDetail] = useState<boolean>(true);
  const [showSalesBars, setShowSalesBars] = useState<boolean>(true);

  // Table search
  const [searchFilter, setSearchFilter] = useState<string>("");

  // Product Combobox / Search
  const [productSearch, setProductSearch] = useState<string>("");
  const [isSearchOpen, setIsSearchOpen] = useState<boolean>(false);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  // Close combobox when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target as Node)) {
        setIsSearchOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // 1. Load catalog overview
  useEffect(() => {
    setCatalogLoading(true);
    setCatalogError(null);
    fetch(`${API_URL}/api/bsr/catalog`)
      .then(async (res) => {
        if (!res.ok) {
          const errData = await res.json().catch(() => null);
          throw new Error(errData?.message || errData?.error || `HTTP ${res.status}`);
        }
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
    const controller = new AbortController();
    setProductHistory(null);
    setHistoryError(null);
    setHistoryLoading(true);

    fetch(`${API_URL}/api/bsr/history/${encodeURIComponent(selectedAsin)}?days=${historyDays}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const errData = await res.json().catch(() => null);
          throw new Error(errData?.message || errData?.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data: ProductBsrHistoryResult) => {
        if (!controller.signal.aborted) setProductHistory(data);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setHistoryError(err instanceof Error ? err.message : "Error cargando historial BSR");
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false);
      });
    return () => controller.abort();
  }, [selectedAsin, historyDays]);

  // Handle live refresh
  const handleRefreshLive = async () => {
    if (!selectedAsin) return;
    setRefreshing(true);
    try {
      const res = await fetch(`${API_URL}/api/bsr/refresh/${encodeURIComponent(selectedAsin)}`, {
        method: "POST",
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => null);
        throw new Error(errJson?.message || `HTTP ${res.status}`);
      }
      // Re-fetch history to update view
      const histRes = await fetch(
        `${API_URL}/api/bsr/history/${encodeURIComponent(selectedAsin)}?days=${historyDays}`
      );
      if (histRes.ok) {
        const histData = await histRes.json();
        setProductHistory(histData);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "No se pudo conectar con Amazon SP-API para refrescar en vivo.");
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

  const matchingProducts = useMemo(() => {
    if (!productSearch.trim()) return catalog;
    const term = productSearch.toLowerCase().trim();
    return catalog.filter(
      (p) =>
        p.sku.toLowerCase().includes(term) ||
        p.name.toLowerCase().includes(term) ||
        p.asin.toLowerCase().includes(term)
    );
  }, [catalog, productSearch]);

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

      {(catalogError || historyError) && (
        <div className="p-4 rounded-lg bg-red-950/40 border border-red-800 text-red-300 text-sm">
          Error: {catalogError || historyError}
        </div>
      )}

      {/* Product Search & Selector Bar */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4">
          {/* Search Box by SKU or Title */}
          <div className="flex-1 relative" ref={searchContainerRef}>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
              Buscar Producto por SKU o Título:
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                🔍
              </span>
              <input
                type="text"
                value={productSearch}
                onChange={(e) => {
                  setProductSearch(e.target.value);
                  setIsSearchOpen(true);
                }}
                onFocus={() => setIsSearchOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && matchingProducts.length > 0) {
                    setSelectedAsin(matchingProducts[0].asin);
                    setIsSearchOpen(false);
                  } else if (e.key === "Escape") {
                    setIsSearchOpen(false);
                  }
                }}
                placeholder={
                  selectedProduct
                    ? `Activo: ${maskSku(selectedProduct.sku)} — ${maskProductName(selectedProduct.name, selectedProduct.sku).slice(0, 35)}... (Escribe para buscar otro)`
                    : "Escribe SKU o palabras del título..."
                }
                className="w-full pl-9 pr-24 py-2.5 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none transition-all shadow-inner"
              />

              <div className="absolute inset-y-0 right-0 pr-2 flex items-center gap-1.5">
                {productSearch && (
                  <button
                    type="button"
                    onClick={() => {
                      setProductSearch("");
                      setIsSearchOpen(false);
                    }}
                    className="p-1 text-slate-400 hover:text-slate-200 text-xs"
                    title="Limpiar búsqueda"
                  >
                    ✕
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setIsSearchOpen(!isSearchOpen)}
                  className="p-1 text-slate-400 hover:text-indigo-400 text-xs transition-colors"
                  title="Abrir/Cerrar lista"
                >
                  {isSearchOpen ? "▲" : "▼"}
                </button>
              </div>
            </div>

            {/* Autocomplete Dropdown */}
            {isSearchOpen && (
              <div className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-xl border border-slate-700/80 bg-slate-950/95 shadow-2xl backdrop-blur-md max-h-80 overflow-y-auto divide-y divide-slate-800/60">
                <div className="px-3 py-2 bg-slate-900/80 text-[11px] font-semibold text-slate-400 flex items-center justify-between sticky top-0 backdrop-blur z-10 border-b border-slate-800">
                  <span>
                    {productSearch
                      ? `Resultados para "${productSearch}" (${matchingProducts.length})`
                      : `Catálogo de productos (${matchingProducts.length})`}
                  </span>
                  <span className="text-[10px] text-slate-500 font-normal">Pulsa para seleccionar</span>
                </div>

                {catalogLoading ? (
                  <div className="p-4 text-xs text-slate-400 text-center flex items-center justify-center gap-2">
                    <span className="h-3 w-3 animate-spin rounded-full border border-slate-600 border-t-indigo-400" />
                    <span>Cargando catálogo...</span>
                  </div>
                ) : matchingProducts.length === 0 ? (
                  <div className="p-4 text-xs text-slate-400 text-center italic">
                    No se encontraron productos coincidentes con &ldquo;{productSearch}&rdquo;.
                  </div>
                ) : (
                  matchingProducts.map((p) => {
                    const isSelected = p.asin === selectedAsin;
                    const displaySku = maskSku(p.sku);
                    const displayName = maskProductName(p.name, p.sku);
                    const rankNum = p.detailCategory?.rank || p.rootCategory?.rank;
                    const catTitle = p.detailCategory?.title || p.rootCategory?.title;

                    return (
                      <button
                        key={p.asin}
                        type="button"
                        onClick={() => {
                          setSelectedAsin(p.asin);
                          setProductSearch("");
                          setIsSearchOpen(false);
                        }}
                        className={`w-full text-left p-3 flex flex-col gap-1 transition-colors ${
                          isSelected
                            ? "bg-indigo-600/20 border-l-4 border-indigo-500"
                            : "hover:bg-slate-900/90"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
                              {displaySku}
                            </span>
                            <span className="font-mono text-[11px] text-slate-400 bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">
                              ASIN: {maskAsin(p.asin)}
                            </span>
                          </div>
                          {rankNum ? (
                            <span className="text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 whitespace-nowrap">
                              🏆 #{rankNum.toLocaleString("es-ES")}
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-500 italic">Sin rango BSR</span>
                          )}
                        </div>
                        <p className="text-xs text-slate-200 font-medium line-clamp-1">
                          {displayName}
                        </p>
                        {catTitle && (
                          <span className="text-[10px] text-slate-400 truncate">
                            📁 {catTitle}
                          </span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* Fallback Native Select for direct list picking */}
          <div className="w-full lg:w-72 shrink-0">
            <label htmlFor="asin-select" className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
              Selector Directo:
            </label>
            {catalogLoading ? (
              <div className="text-xs text-slate-400 flex items-center gap-2 py-2">
                <span className="h-3 w-3 animate-spin rounded-full border border-slate-600 border-t-indigo-400" />
                <span>Cargando...</span>
              </div>
            ) : catalog.length === 0 ? (
              <span className="text-xs text-slate-500 italic py-2 block">Sin productos</span>
            ) : (
              <select
                id="asin-select"
                value={selectedAsin}
                onChange={(e) => setSelectedAsin(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                {catalog.map((p) => {
                  const displaySku = maskSku(p.sku);
                  const displayName = maskProductName(p.name, p.sku);
                  return (
                    <option key={p.asin} value={p.asin}>
                      {displaySku} — {displayName.slice(0, 35)}...
                    </option>
                  );
                })}
              </select>
            )}
          </div>
        </div>

        {/* Selected Product Banner */}
        {selectedProduct && (
          <div className="pt-3 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-slate-400 font-medium">Producto seleccionado:</span>
              <span className="font-mono font-semibold text-indigo-300 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20">
                SKU: {maskSku(selectedProduct.sku)}
              </span>
              <span className="font-mono text-slate-300 bg-slate-950 px-2 py-0.5 rounded border border-slate-800">
                ASIN: {maskAsin(selectedProduct.asin)}
              </span>
              <span className="text-slate-200 font-medium max-w-md truncate">
                {maskProductName(selectedProduct.name, selectedProduct.sku)}
              </span>
            </div>
            {selectedProduct.detailCategory?.rank && (
              <div className="flex items-center gap-1.5 text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-md border border-emerald-500/20">
                <span>🏆 Rango BSR:</span>
                <span className="font-bold font-mono">#{selectedProduct.detailCategory.rank.toLocaleString("es-ES")}</span>
              </div>
            )}
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

        {!historyLoading && !productHistory && (
          <div className="flex flex-col items-center justify-center py-20 text-center text-slate-400 space-y-2">
            <span className="text-2xl">📊</span>
            <p className="text-sm font-medium text-slate-300">
              {catalog.length === 0 ? "Sin datos de catálogo" : "Historial de BSR no disponible"}
            </p>
            <p className="text-xs text-slate-500 max-w-md">
              {catalog.length === 0
                ? "Ejecuta el workflow 'Sync Amazon data → Supabase' en GitHub Actions o corre los scripts de sincronización en local para cargar los datos."
                : "Aún no se ha generado la serie temporal para este producto. Se sincronizará en la próxima ejecución."}
            </p>
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
              {catalogLoading ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-xs text-slate-500">
                    Cargando ranking BSR del catálogo...
                  </td>
                </tr>
              ) : filteredCatalog.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-xs text-slate-500">
                    <p className="text-slate-400 font-medium">No se encontraron productos en el catálogo</p>
                    <p className="text-slate-600 text-[11px] mt-1">
                      Ejecuta el workflow de sincronización en GitHub Actions o corre los scripts locales para poblar los rankings.
                    </p>
                  </td>
                </tr>
              ) : (
                filteredCatalog.map((prod) => {
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
              }))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
