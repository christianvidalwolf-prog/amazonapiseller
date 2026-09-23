"use client";

import { API_ORIGIN } from "@/lib/apiBase";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePrivacy } from "@/lib/PrivacyContext";

interface PricingProductSummary {
  asin: string;
  sku: string;
  name: string;
  stock: number;
  hasBuyBox: boolean;
  buyBoxStatus: "WON" | "LOST" | "NONE";
  buyBoxPrice: number | null;
  currency: string;
  totalOffers: number;
  competingOffersCount: number;
  salesRank: number | null;
  salesCategory: string | null;
}

interface PricingDashboardSummary {
  totalAnalyzed: number;
  buyBoxWonCount: number;
  buyBoxLostCount: number;
  noBuyBoxCount: number;
  buyBoxWinRate: number;
  multiOfferCount: number;
  products: PricingProductSummary[];
  cachedAt: string;
}

interface CompetitorOffer {
  sellerId?: string | null;
  sellerUrl?: string | null;
  isMyOffer?: boolean;
  isBuyBoxWinner: boolean;
  isFulfilledByAmazon: boolean;
  listingPrice: number;
  shippingPrice: number;
  totalPrice: number;
  currency: string;
  feedbackCount: number;
  positiveFeedbackRating: number | null;
  shipsFromCountry: string | null;
  condition: string;
  priceDifference: number | null;
}

interface ProductOffersDetail {
  asin: string;
  buyBoxPrice: number | null;
  currency: string;
  totalOffersCount: number;
  offers: CompetitorOffer[];
}

const API_BASE = `${API_ORIGIN}/api/pricing`;

export default function PricingPage() {
  const { isPrivacyMode, maskProductName, maskSku, maskAsin } = usePrivacy();
  const [data, setData] = useState<PricingDashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filtros
  const [filterStatus, setFilterStatus] = useState<"ALL" | "WON" | "LOST" | "MULTI" | "NONE">("ALL");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(40);

  // Modal de ofertas de competidores
  const [selectedAsin, setSelectedAsin] = useState<string | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<PricingProductSummary | null>(null);
  const [offersDetail, setOffersDetail] = useState<ProductOffersDetail | null>(null);
  const [loadingOffers, setLoadingOffers] = useState(false);
  const [offersError, setOffersError] = useState<string | null>(null);
  const offersRequest = useRef<AbortController | null>(null);
  useEffect(() => () => offersRequest.current?.abort(), []);

  const fetchPricingData = async (force = false) => {
    if (force) setRefreshing(true);
    else setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/summary?limit=${limit}&force=${force}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: PricingDashboardSummary = await res.json();
      setData(json);
      setError(null);
    } catch (err: unknown) {
      setError("No se pudo cargar la información de precios desde el servidor.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchPricingData();
  }, [limit]);

  const openCompetitorsModal = async (prod: PricingProductSummary) => {
    offersRequest.current?.abort();
    const controller = new AbortController();
    offersRequest.current = controller;
    setOffersError(null);
    setSelectedAsin(prod.asin);
    setSelectedProduct(prod);
    setLoadingOffers(true);
    setOffersDetail(null);

    try {
      const res = await fetch(`${API_BASE}/offers?asin=${encodeURIComponent(prod.asin)}`, { signal: controller.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || `No se pudieron cargar las ofertas (HTTP ${res.status}).`);
      }
      const detail: ProductOffersDetail = await res.json();
      if (!controller.signal.aborted) setOffersDetail(detail);
    } catch (err) {
      if (!controller.signal.aborted) setOffersError(err instanceof Error ? err.message : "No se pudieron cargar las ofertas.");
    } finally {
      if (!controller.signal.aborted) setLoadingOffers(false);
    }
  };

  const closeModal = () => {
    offersRequest.current?.abort();
    setOffersError(null);
    setSelectedAsin(null);
    setSelectedProduct(null);
    setOffersDetail(null);
  };

  // Filtrado de productos
  const filteredProducts = (data?.products || []).filter((p) => {
    // Filtro por texto
    if (search.trim()) {
      const q = search.toLowerCase();
      const matchSku = p.sku.toLowerCase().includes(q);
      const matchAsin = p.asin.toLowerCase().includes(q);
      const matchName = p.name.toLowerCase().includes(q);
      if (!matchSku && !matchAsin && !matchName) return false;
    }

    // Filtro por estado
    if (filterStatus === "WON") return p.buyBoxStatus === "WON";
    if (filterStatus === "LOST") return p.buyBoxStatus === "LOST";
    if (filterStatus === "NONE") return p.buyBoxStatus === "NONE";
    if (filterStatus === "MULTI") return p.totalOffers > 1;

    return true;
  });

  return (
    <main className="max-w-7xl mx-auto px-6 py-8">
      {/* Header y Migas */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-800 pb-6 mb-8">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Link href="/" className="text-xs text-slate-400 hover:text-slate-200">
              Inicio
            </Link>
            <span className="text-xs text-slate-600">/</span>
            <span className="text-xs text-indigo-400 font-medium">Precios y Buy Box</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-3">
            Monitor de Precios Competitivos y Buy Box
            {data?.buyBoxLostCount ? (
              <span className="text-xs bg-rose-500/20 text-rose-300 border border-rose-500/30 px-2.5 py-0.5 rounded-full flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-rose-500"></span>
                {data.buyBoxLostCount} en Riesgo
              </span>
            ) : null}
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Señales en tiempo real de SP-API: monitoriza si ganas la oferta destacada (Buy Box) y analiza a los vendedores competidores.
          </p>
        </div>

        {/* Acciones */}
        <div className="flex items-center gap-3">
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
          >
            <option value={20}>Analizar 20 ASINs</option>
            <option value={40}>Analizar 40 ASINs</option>
            <option value={60}>Analizar 60 ASINs</option>
            <option value={100}>Analizar 100 ASINs</option>
          </select>

          <Link
            href="/listings"
            className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-all flex items-center gap-1.5 shadow-sm"
          >
            <span>📄</span> Subir Precios CSV
          </Link>

          <button
            onClick={() => fetchPricingData(true)}
            disabled={refreshing || loading}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-all flex items-center gap-2 shadow-sm disabled:opacity-50"
          >
            <svg
              className={`w-3.5 h-3.5 ${refreshing ? "animate-spin text-amber-300" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {refreshing ? "Consultando SP-API..." : "Actualizar Precios"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 rounded-lg bg-rose-950/40 border border-rose-800/60 text-rose-300 text-sm">
          {error}
        </div>
      )}

      {/* Tarjetas KPI de Estado de Buy Box */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {/* Tasa de Ganancia */}
        <div className="p-5 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col justify-between">
          <div>
            <p className="text-xs font-medium text-slate-400">Tasa de Victoria Buy Box</p>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-extrabold text-emerald-400">
                {data ? `${data.buyBoxWinRate}%` : "--"}
              </span>
              <span className="text-xs text-slate-400">de productos con Buy Box activa</span>
            </div>
          </div>
          <div className="mt-4 w-full bg-slate-800 rounded-full h-2 overflow-hidden">
            <div
              className="bg-emerald-500 h-2 rounded-full transition-all duration-500"
              style={{ width: `${data?.buyBoxWinRate || 0}%` }}
            ></div>
          </div>
        </div>

        {/* Buy Box Ganada */}
        <div className="p-5 rounded-xl bg-slate-900/60 border border-slate-800">
          <p className="text-xs font-medium text-slate-400">Buy Box Ganada (Tu Oferta)</p>
          <p className="text-3xl font-extrabold text-emerald-400 mt-2">
            {data ? data.buyBoxWonCount : "--"}
          </p>
          <p className="text-xs text-slate-400 mt-2 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
            Tienes la oferta destacada activa
          </p>
        </div>

        {/* Buy Box Perdida */}
        <div className="p-5 rounded-xl bg-slate-900/60 border border-slate-800">
          <p className="text-xs font-medium text-slate-400">Buy Box Perdida / En Riesgo</p>
          <p className={`text-3xl font-extrabold mt-2 ${data?.buyBoxLostCount ? "text-rose-400" : "text-slate-100"}`}>
            {data ? data.buyBoxLostCount : "--"}
          </p>
          <p className="text-xs text-slate-400 mt-2 flex items-center gap-1.5">
            {data?.buyBoxLostCount ? (
              <>
                <span className="w-2 h-2 rounded-full bg-rose-500"></span>
                <span className="text-rose-300">Un competidor tiene la Buy Box</span>
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                Sin pérdidas detectadas
              </>
            )}
          </p>
        </div>

        {/* Competencia Múltiple */}
        <div className="p-5 rounded-xl bg-slate-900/60 border border-slate-800">
          <p className="text-xs font-medium text-slate-400">Con Competencia Directa</p>
          <p className="text-3xl font-extrabold text-amber-400 mt-2">
            {data ? data.multiOfferCount : "--"}
          </p>
          <p className="text-xs text-slate-400 mt-2 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-400"></span>
            Productos con 2 o más vendedores
          </p>
        </div>
      </div>

      {/* Barra de Filtros y Buscador */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        {/* Pestañas de Filtro */}
        <div className="flex items-center gap-1 bg-slate-900/80 p-1 rounded-xl border border-slate-800 text-xs overflow-x-auto">
          <button
            onClick={() => setFilterStatus("ALL")}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
              filterStatus === "ALL" ? "bg-indigo-600 text-white shadow" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Todos ({data?.products.length ?? 0})
          </button>
          <button
            onClick={() => setFilterStatus("LOST")}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
              filterStatus === "LOST"
                ? "bg-rose-600 text-white shadow"
                : "text-slate-400 hover:text-rose-300"
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-rose-400"></span>
            En Riesgo / Perdida ({data?.buyBoxLostCount ?? 0})
          </button>
          <button
            onClick={() => setFilterStatus("MULTI")}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
              filterStatus === "MULTI"
                ? "bg-amber-600 text-white shadow"
                : "text-slate-400 hover:text-amber-300"
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
            Con Competidores ({data?.multiOfferCount ?? 0})
          </button>
          <button
            onClick={() => setFilterStatus("WON")}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
              filterStatus === "WON"
                ? "bg-emerald-600 text-white shadow"
                : "text-slate-400 hover:text-emerald-300"
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
            Ganadas ({data?.buyBoxWonCount ?? 0})
          </button>
          <button
            onClick={() => setFilterStatus("NONE")}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
              filterStatus === "NONE" ? "bg-slate-700 text-white shadow" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Sin Buy Box ({data?.noBuyBoxCount ?? 0})
          </button>
        </div>

        {/* Buscador */}
        <div className="relative w-full md:w-80">
          <input
            type="text"
            placeholder="Buscar por SKU, ASIN o título..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-slate-900 border border-slate-800 rounded-xl px-4 py-2 pl-9 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
          <svg
            className="w-4 h-4 text-slate-500 absolute left-3 top-2.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
      </div>

      {/* Tabla de Productos y Buy Box */}
      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/40">
        <table className="w-full text-left text-xs text-slate-300">
          <thead className="bg-slate-950/80 text-slate-400 uppercase tracking-wider border-b border-slate-800">
            <tr>
              <th className="px-4 py-3">Producto / Identificadores</th>
              <th className="px-4 py-3">Stock FBA</th>
              <th className="px-4 py-3">Estado Buy Box</th>
              <th className="px-4 py-3 text-right">Precio Buy Box</th>
              <th className="px-4 py-3 text-center">Vendedores</th>
              <th className="px-4 py-3">BSR (Ranking)</th>
              <th className="px-4 py-3 text-right">Acción</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-slate-400">
                  <div className="flex flex-col items-center justify-center gap-2">
                    <svg className="animate-spin h-6 w-6 text-indigo-400" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                    </svg>
                    <span>Consultando precios competitivos en Amazon SP-API...</span>
                  </div>
                </td>
              </tr>
            ) : filteredProducts.length > 0 ? (
              filteredProducts.map((p) => {
                const displaySku = maskSku(p.sku);
                const displayAsin = maskAsin(p.asin);
                const displayName = maskProductName(p.name, p.sku);

                return (
                <tr key={p.asin} className="hover:bg-slate-800/30 transition-colors">
                  {/* Identificadores */}
                  <td className="px-4 py-3 max-w-md">
                    <p className="font-medium text-slate-200 line-clamp-1">{displayName}</p>
                    <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-400 font-mono">
                      <span>SKU: <strong className="text-slate-300">{displaySku}</strong></span>
                      <span>ASIN: {isPrivacyMode ? <strong className="text-indigo-400">{displayAsin}</strong> : <a href={`https://www.amazon.es/dp/${p.asin}`} target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">{displayAsin} ↗</a>}</span>
                    </div>
                  </td>

                  {/* Stock */}
                  <td className="px-4 py-3">
                    <span className="font-semibold text-slate-200">{p.stock}</span> uds
                  </td>

                  {/* Estado Buy Box */}
                  <td className="px-4 py-3">
                    {p.buyBoxStatus === "WON" && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                        Ganada (Tuya)
                      </span>
                    )}
                    {p.buyBoxStatus === "LOST" && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-rose-500/15 text-rose-400 border border-rose-500/30 animate-pulse">
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
                        Perdida
                      </span>
                    )}
                    {p.buyBoxStatus === "NONE" && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-slate-800 text-slate-400 border border-slate-700">
                        Sin Buy Box
                      </span>
                    )}
                  </td>

                  {/* Precio */}
                  <td className="px-4 py-3 text-right">
                    {p.buyBoxPrice !== null ? (
                      <span className="font-bold text-slate-100 text-sm">
                        {p.buyBoxPrice.toFixed(2)} {p.currency}
                      </span>
                    ) : (
                      <span className="text-slate-500">--</span>
                    )}
                  </td>

                  {/* Vendedores / Ofertas */}
                  <td className="px-4 py-3 text-center">
                    {p.totalOffers > 1 ? (
                      <button type="button" onClick={() => openCompetitorsModal(p)} className="inline-flex items-center px-2 py-1 rounded-full text-[11px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25">
                        {p.totalOffers} ofertas · Ver vendedores
                      </button>
                    ) : (
                      <span className="text-slate-400 text-[11px]">{p.totalOffers === 1 ? "1 oferta" : "Sin ofertas"}</span>
                    )}
                  </td>

                  {/* BSR */}
                  <td className="px-4 py-3 text-slate-400 text-[11px]">
                    {p.salesRank ? (
                      <div>
                        <span className="text-slate-200 font-semibold">#{p.salesRank.toLocaleString("es-ES")}</span>
                        <p className="text-[10px] text-slate-500 truncate max-w-[120px]">{p.salesCategory || ""}</p>
                      </div>
                    ) : (
                      <span className="text-slate-600">Sin BSR</span>
                    )}
                  </td>

                  {/* Acción */}
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => openCompetitorsModal(p)}
                      className="px-2.5 py-1 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-indigo-300 hover:text-indigo-200 border border-slate-700 transition-colors"
                    >
                      Ver Competencia
                    </button>
                  </td>
                </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                  No se encontraron productos con el filtro aplicado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* MODAL DE ANÁLISIS DE COMPETIDORES */}
      {selectedAsin && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-5xl w-full p-6 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            {/* Cabecera Modal */}
            <div className="flex items-start justify-between border-b border-slate-800 pb-4 mb-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-mono">
                    {maskAsin(selectedProduct?.asin)}
                  </span>
                  <span className="text-xs text-slate-400 font-mono">SKU: {maskSku(selectedProduct?.sku)}</span>
                </div>
                <h2 className="text-base font-bold text-slate-100 line-clamp-1">
                  {maskProductName(selectedProduct?.name, selectedProduct?.sku)}
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Precio Buy Box actual:{" "}
                  <strong className="text-slate-100 font-semibold">
                    {selectedProduct?.buyBoxPrice ? `${selectedProduct.buyBoxPrice.toFixed(2)} €` : "No disponible"}
                  </strong>
                </p>
              </div>

              <button
                onClick={closeModal}
                className="text-slate-400 hover:text-slate-100 p-1 rounded-lg hover:bg-slate-800 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Contenido Modal */}
            <div className="flex-1 overflow-y-auto pr-1">
              {loadingOffers ? (
                <div className="py-16 text-center text-slate-400 flex flex-col items-center justify-center gap-2">
                  <svg className="animate-spin h-6 w-6 text-indigo-400" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                  </svg>
                  <span className="text-xs">Cargando vendedores y ofertas...</span>
                </div>
              ) : offersError ? (
                <div role="alert" className="rounded-lg border border-rose-800 bg-rose-950/30 p-4 text-sm text-rose-300">{offersError}</div>
              ) : offersDetail && offersDetail.offers.length > 0 ? (
                <div>
                  <div className="mb-3 flex items-center justify-between text-xs text-slate-400">
                    <span>Ofertas analizadas: <strong className="text-slate-200">{offersDetail.offers.length}</strong></span>
                    <a
                      href={`https://www.amazon.es/dp/${selectedAsin}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-indigo-400 hover:underline flex items-center gap-1"
                    >
                      Ver en Amazon.es ↗
                    </a>
                  </div>

                  <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
                    <table className="w-full text-left text-xs text-slate-300">
                      <thead className="bg-slate-900 text-slate-400 uppercase tracking-wider border-b border-slate-800">
                        <tr>
                          <th className="px-4 py-3">Vendedor</th>
                          <th className="px-4 py-3">Estado Oferta</th>
                          <th className="px-4 py-3">Canal</th>
                          <th className="px-4 py-3 text-right">Precio Producto</th>
                          <th className="px-4 py-3 text-right">Envío</th>
                          <th className="px-4 py-3 text-right">Precio Total</th>
                          <th className="px-4 py-3 text-right">Diferencia</th>
                          <th className="px-4 py-3">Valoraciones / Origen</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {offersDetail.offers.map((offer, idx) => (
                          <tr
                            key={idx}
                            className={offer.isBuyBoxWinner ? "bg-emerald-950/20" : "hover:bg-slate-900/50"}
                          >
                            <td className="px-4 py-3 min-w-[180px]">
                              {offer.isMyOffer && <p className="mb-1 font-semibold text-indigo-300">Tu oferta</p>}
                              <p className="font-mono text-slate-200">{offer.sellerId || "Identificador no facilitado"}</p>
                              {offer.sellerUrl && (
                                <a href={offer.sellerUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-indigo-400 hover:underline">
                                  Ver perfil del vendedor ↗
                                </a>
                              )}
                            </td>
                            <td className="px-4 py-3 font-medium">
                              {offer.isBuyBoxWinner ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                                  👑 Ganador Buy Box
                                </span>
                              ) : (
                                <span className="text-slate-400 text-[11px]">{offer.isMyOffer ? "Tu oferta" : "Otra oferta"}</span>
                              )}
                            </td>

                            <td className="px-4 py-3">
                              {offer.isFulfilledByAmazon ? (
                                <span className="text-[11px] text-cyan-400 font-semibold bg-cyan-950/50 px-2 py-0.5 rounded border border-cyan-800/50">
                                  FBA (Amazon)
                                </span>
                              ) : (
                                <span className="text-[11px] text-amber-400 font-semibold bg-amber-950/50 px-2 py-0.5 rounded border border-amber-800/50">
                                  FBM (Merchant)
                                </span>
                              )}
                            </td>

                            <td className="px-4 py-3 text-right font-medium text-slate-200">
                              {offer.listingPrice.toFixed(2)} {offer.currency}
                            </td>

                            <td className="px-4 py-3 text-right text-slate-400">
                              {offer.shippingPrice > 0 ? `${offer.shippingPrice.toFixed(2)} ${offer.currency}` : "Gratis"}
                            </td>

                            <td className="px-4 py-3 text-right font-bold text-slate-100">
                              {offer.totalPrice.toFixed(2)} {offer.currency}
                            </td>

                            <td className="px-4 py-3 text-right font-mono text-xs">
                              {offer.priceDifference !== null ? (
                                offer.priceDifference === 0 ? (
                                  <span className="text-slate-400">0.00 €</span>
                                ) : offer.priceDifference > 0 ? (
                                  <span className="text-rose-400">+{offer.priceDifference.toFixed(2)} €</span>
                                ) : (
                                  <span className="text-emerald-400">{offer.priceDifference.toFixed(2)} €</span>
                                )
                              ) : (
                                "--"
                              )}
                            </td>

                            <td className="px-4 py-3 text-[11px] text-slate-400">
                              <p>
                                {offer.feedbackCount > 0 ? `${offer.feedbackCount} opiniones` : "Sin opiniones"}
                              </p>
                              <p className="text-[10px] text-slate-500">
                                Origen: {offer.shipsFromCountry || "No indicado"}
                              </p>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="py-12 text-center text-slate-500 text-xs">
                  No se encontraron ofertas activas de competidores para este producto.
                </div>
              )}
            </div>

            {/* Pie Modal */}
            <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between">
              <span className="text-[11px] text-slate-500">
                Amazon facilita el identificador del vendedor. Consulta su nombre comercial en el enlace a su perfil.
              </span>
              <button
                onClick={closeModal}
                className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
