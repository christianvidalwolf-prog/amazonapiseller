"use client";

import React, { useMemo, useState } from "react";
import { usePrivacy } from "@/lib/PrivacyContext";

export interface PeriodProductDetail {
  sku: string;
  asin: string;
  name: string;
  units: number;
  returnedUnits?: number;
  netUnits?: number;
  revenue: number;
  returnedRevenue?: number;
  netRevenue?: number;
  returnRatePct?: number | null;
  avgPrice: number;
  orderCount: number;
}

export interface PeriodOrderItemDetail {
  sku: string;
  asin: string;
  name: string;
  quantity: number;
  itemPrice: number;
  itemTax: number;
  shippingPrice: number;
  totalPrice: number;
}

export interface PeriodOrderDetail {
  orderId: string;
  purchaseDate: string;
  orderStatus: string;
  salesChannel: string;
  fulfillmentChannel: string;
  shipCity: string;
  shipState: string;
  shipPostalCode: string;
  shipCountry: string;
  isPrime: boolean;
  isBusinessOrder: boolean;
  currency: string;
  totalUnits: number;
  totalRevenue: number;
  items: PeriodOrderItemDetail[];
}

export interface PeriodReturnDetail {
  returnDate: string;
  orderId: string;
  sku: string;
  asin: string;
  name: string;
  quantity: number;
  refundAmount: number;
  reason: string;
  reasonLabel: string;
  detailedDisposition: string;
  status: string;
  customerComments: string;
  fulfillmentCenterId: string;
  licensePlateNumber: string;
  salesChannel: string;
}

export interface PeriodSalesDetailResult {
  start: string;
  end: string;
  channel: string;
  metrics: {
    totalRevenue: number;
    returnedRevenue?: number;
    netRevenue?: number;
    totalUnits: number;
    returnedUnits?: number;
    netUnits?: number;
    totalOrders: number;
    totalReturns?: number;
    avgOrderValue: number;
    returnRatePct?: number | null;
  };
  products: PeriodProductDetail[];
  orders: PeriodOrderDetail[];
  returns?: PeriodReturnDetail[];
}

interface Props {
  title: string;
  data: PeriodSalesDetailResult | null;
  loading: boolean;
  error?: string | null;
  onClose?: () => void;
}

const currencyFull = (value: number) =>
  value.toLocaleString("es-ES", { style: "currency", currency: "EUR" });
const number = (value: number) => value.toLocaleString("es-ES");

const formatTime = (iso: string) => {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  } catch {
    return iso.slice(11, 16);
  }
};

const formatFullDate = (iso: string) => {
  try {
    const d = new Date(iso);
    return d.toLocaleString("es-ES", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
};

export function PeriodSalesDetail({ title, data, loading, error, onClose }: Props) {
  const { maskProductName, maskSku, maskAsin } = usePrivacy();
  const [activeTab, setActiveTab] = useState<"products" | "orders" | "returns">("products");
  const [searchTerm, setSearchTerm] = useState("");
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [copiedOrderId, setCopiedOrderId] = useState<string | null>(null);

  const handleCopyOrderId = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(id);
    setCopiedOrderId(id);
    setTimeout(() => setCopiedOrderId(null), 2000);
  };

  const filteredProducts = useMemo(() => {
    if (!data?.products) return [];
    if (!searchTerm.trim()) return data.products;
    const term = searchTerm.toLowerCase();
    return data.products.filter(
      (p) =>
        p.name.toLowerCase().includes(term) ||
        p.sku.toLowerCase().includes(term) ||
        p.asin.toLowerCase().includes(term)
    );
  }, [data?.products, searchTerm]);

  const filteredOrders = useMemo(() => {
    if (!data?.orders) return [];
    if (!searchTerm.trim()) return data.orders;
    const term = searchTerm.toLowerCase();
    return data.orders.filter(
      (o) =>
        o.orderId.toLowerCase().includes(term) ||
        o.shipCity.toLowerCase().includes(term) ||
        o.salesChannel.toLowerCase().includes(term) ||
        o.items.some(
          (i) =>
            i.name.toLowerCase().includes(term) ||
            i.sku.toLowerCase().includes(term) ||
            i.asin.toLowerCase().includes(term)
        )
    );
  }, [data?.orders, searchTerm]);

  const filteredReturns = useMemo(() => {
    if (!data?.returns) return [];
    if (!searchTerm.trim()) return data.returns;
    const term = searchTerm.toLowerCase();
    return data.returns.filter(
      (r) =>
        r.orderId.toLowerCase().includes(term) ||
        r.sku.toLowerCase().includes(term) ||
        r.asin.toLowerCase().includes(term) ||
        r.name.toLowerCase().includes(term) ||
        r.reason.toLowerCase().includes(term) ||
        r.reasonLabel.toLowerCase().includes(term) ||
        r.customerComments.toLowerCase().includes(term)
    );
  }, [data?.returns, searchTerm]);

  const hasReturns = (data?.metrics.returnedUnits ?? 0) > 0 || (data?.returns?.length ?? 0) > 0;
  const returnedRev = data?.metrics.returnedRevenue ?? 0;
  const netRev = data?.metrics.netRevenue ?? (data ? data.metrics.totalRevenue - returnedRev : 0);
  const returnedUds = data?.metrics.returnedUnits ?? 0;
  const netUds = data?.metrics.netUnits ?? (data ? data.metrics.totalUnits - returnedUds : 0);

  return (
    <div className="rounded-xl border border-indigo-500/30 bg-slate-900/90 backdrop-blur p-4 sm:p-6 shadow-2xl space-y-5 animate-in fade-in slide-in-from-top-2 duration-200">
      {/* Header bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between pb-4 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wider bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
              Desglose Detallado
            </span>
            <h3 className="text-base font-bold text-slate-100">{title}</h3>
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            Productos, pedidos y devoluciones registradas en este periodo para el canal seleccionado.
          </p>
        </div>

        <div className="flex items-center gap-2 self-end sm:self-auto">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white text-xs font-medium transition-colors flex items-center gap-1.5"
            >
              <span>✕</span> Cerrar Desglose
            </button>
          )}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-3 py-12 text-slate-400">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-indigo-400" />
          <span className="text-sm">Cargando productos, pedidos y devoluciones de este periodo...</span>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-rose-800 bg-rose-950/40 p-4 text-xs text-rose-300">
          {error}
        </div>
      )}

      {!loading && !error && data && (
        <>
          {/* Quick Metrics Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Facturación Bruta
              </span>
              <p className="text-base sm:text-lg font-bold text-indigo-300 mt-0.5 font-mono">
                {currencyFull(data.metrics.totalRevenue)}
              </p>
            </div>

            <div className="rounded-lg border border-rose-900/40 bg-rose-950/20 p-3">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-rose-400 flex items-center justify-between">
                <span>Devoluciones</span>
                {data.metrics.returnRatePct !== null && data.metrics.returnRatePct !== undefined && (
                  <span className="text-[9px] px-1 py-0.2 rounded bg-rose-500/20 text-rose-300 font-mono">
                    {data.metrics.returnRatePct}%
                  </span>
                )}
              </span>
              <p className="text-base sm:text-lg font-bold text-rose-400 mt-0.5 font-mono">
                -{currencyFull(returnedRev)}
              </p>
              <p className="text-[10px] text-rose-400/80 mt-0.5">
                {number(returnedUds)} uds devueltas
              </p>
            </div>

            <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/20 p-3">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                Facturación Neta
              </span>
              <p className="text-base sm:text-lg font-bold text-emerald-400 mt-0.5 font-mono">
                {currencyFull(netRev)}
              </p>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Unidades Netas
              </span>
              <p className="text-base sm:text-lg font-bold text-blue-400 mt-0.5">
                {number(netUds)} <span className="text-xs font-normal text-slate-400">uds</span>
              </p>
              <p className="text-[10px] text-slate-500 mt-0.5">
                {number(data.metrics.totalUnits)} brutas
              </p>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Nº de Pedidos
              </span>
              <p className="text-base sm:text-lg font-bold text-indigo-400 mt-0.5">
                {number(data.metrics.totalOrders)}
              </p>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Ticket Medio
              </span>
              <p className="text-base sm:text-lg font-bold text-amber-400 mt-0.5 font-mono">
                {currencyFull(data.metrics.avgOrderValue)}
              </p>
            </div>
          </div>

          {/* Navigation Tabs and Search Bar */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2">
            <div className="inline-flex rounded-lg border border-slate-800 bg-slate-950 p-1 text-xs">
              <button
                type="button"
                onClick={() => setActiveTab("products")}
                className={`rounded-md px-3 py-1.5 font-medium transition-colors flex items-center gap-1.5 ${
                  activeTab === "products"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <span>📦</span>
                <span>Productos ({data.products.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("orders")}
                className={`rounded-md px-3 py-1.5 font-medium transition-colors flex items-center gap-1.5 ${
                  activeTab === "orders"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <span>🧾</span>
                <span>Pedidos ({data.orders.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("returns")}
                className={`rounded-md px-3 py-1.5 font-medium transition-colors flex items-center gap-1.5 ${
                  activeTab === "returns"
                    ? "bg-rose-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <span>↩️</span>
                <span>Devoluciones ({data.returns?.length ?? 0})</span>
                {(data.returns?.length ?? 0) > 0 && (
                  <span className="ml-1 px-1.5 py-0.2 rounded-full bg-rose-500/20 text-rose-300 text-[10px] font-bold border border-rose-500/30">
                    {data.returns?.length}
                  </span>
                )}
              </button>
            </div>

            <div className="relative w-full sm:w-64">
              <input
                type="text"
                placeholder={
                  activeTab === "products"
                    ? "Filtrar por SKU, ASIN, título..."
                    : activeTab === "orders"
                    ? "Buscar pedido, ciudad..."
                    : "Buscar devolución, motivo, comentario..."
                }
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 pl-8 text-xs text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
              <span className="absolute left-2.5 top-2 text-slate-500 text-xs">🔍</span>
              {searchTerm && (
                <button
                  type="button"
                  onClick={() => setSearchTerm("")}
                  className="absolute right-2.5 top-2 text-slate-400 hover:text-white text-xs"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Tab 1: Products */}
          {activeTab === "products" && (
            <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/40">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-800 bg-slate-950 text-slate-400 font-semibold uppercase tracking-wider">
                  <tr>
                    <th className="py-2.5 px-3 w-10 text-center">#</th>
                    <th className="py-2.5 px-3">Producto / Referencia</th>
                    <th className="py-2.5 px-3 text-right">Uds Brutas</th>
                    <th className="py-2.5 px-3 text-right">Devueltas</th>
                    <th className="py-2.5 px-3 text-right">Uds Netas</th>
                    <th className="py-2.5 px-3 text-right">Fact. Bruta</th>
                    <th className="py-2.5 px-3 text-right">Devolución</th>
                    <th className="py-2.5 px-3 text-right">Fact. Neta</th>
                    <th className="py-2.5 px-3 text-center">Tasa Dev.</th>
                    <th className="py-2.5 px-3 text-right">Pedidos</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filteredProducts.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="py-8 text-center text-slate-500">
                        No se encontraron productos coincidentes.
                      </td>
                    </tr>
                  ) : (
                    filteredProducts.map((prod, idx) => {
                      const displaySku = maskSku(prod.sku);
                      const displayAsin = maskAsin(prod.asin);
                      const displayName = maskProductName(prod.name, prod.sku);
                      const pReturnedUnits = prod.returnedUnits ?? 0;
                      const pNetUnits = prod.netUnits ?? prod.units - pReturnedUnits;
                      const pReturnedRev = prod.returnedRevenue ?? 0;
                      const pNetRev = prod.netRevenue ?? prod.revenue - pReturnedRev;
                      const pRate = prod.returnRatePct ?? (prod.units > 0 ? (pReturnedUnits / prod.units) * 100 : 0);

                      return (
                        <tr key={prod.sku} className="hover:bg-slate-800/30 transition-colors">
                          <td className="py-2.5 px-3 text-center font-bold text-slate-500">
                            {idx + 1}
                          </td>
                          <td className="py-2.5 px-3 max-w-xs">
                            <div className="font-medium text-slate-200 truncate" title={displayName}>
                              {displayName}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-400 font-mono">
                              <span className="text-indigo-400">{displaySku}</span>
                              {prod.asin && (
                                <span className="text-slate-500 hover:text-slate-300">
                                  ASIN: {displayAsin}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-2.5 px-3 text-right font-medium text-slate-200">
                            {number(prod.units)}
                          </td>
                          <td className="py-2.5 px-3 text-right">
                            {pReturnedUnits > 0 ? (
                              <span className="font-semibold text-rose-400">
                                -{number(pReturnedUnits)}
                              </span>
                            ) : (
                              <span className="text-slate-500">0</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right font-semibold text-blue-400">
                            {number(pNetUnits)}
                          </td>
                          <td className="py-2.5 px-3 text-right text-slate-300 font-mono">
                            {currencyFull(prod.revenue)}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono">
                            {pReturnedRev > 0 ? (
                              <span className="text-rose-400">-{currencyFull(pReturnedRev)}</span>
                            ) : (
                              <span className="text-slate-500">-</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right font-semibold text-emerald-400 font-mono">
                            {currencyFull(pNetRev)}
                          </td>
                          <td className="py-2.5 px-3 text-center">
                            {pReturnedUnits > 0 ? (
                              <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20 font-mono">
                                {pRate.toFixed(1)}%
                              </span>
                            ) : (
                              <span className="text-slate-500 text-[10px]">0%</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right text-slate-400">
                            {prod.orderCount}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Tab 2: Orders */}
          {activeTab === "orders" && (
            <div className="space-y-2">
              <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/40">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-800 bg-slate-950 text-slate-400 font-semibold uppercase tracking-wider">
                    <tr>
                      <th className="py-2.5 px-3">Pedido Amazon</th>
                      <th className="py-2.5 px-3">Hora (UTC)</th>
                      <th className="py-2.5 px-3">Canal</th>
                      <th className="py-2.5 px-3 text-center">Logística</th>
                      <th className="py-2.5 px-3 text-center">Estado</th>
                      <th className="py-2.5 px-3">Destino</th>
                      <th className="py-2.5 px-3 text-right">Artículos</th>
                      <th className="py-2.5 px-3 text-right">Importe</th>
                      <th className="py-2.5 px-3 text-center">Detalle</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {filteredOrders.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="py-8 text-center text-slate-500">
                          No se encontraron pedidos coincidentes.
                        </td>
                      </tr>
                    ) : (
                      filteredOrders.map((order) => {
                        const isExpanded = expandedOrderId === order.orderId;

                        return (
                          <React.Fragment key={order.orderId}>
                            <tr
                              onClick={() => setExpandedOrderId(isExpanded ? null : order.orderId)}
                              className={`cursor-pointer transition-colors ${
                                isExpanded ? "bg-indigo-950/20" : "hover:bg-slate-800/30"
                              }`}
                            >
                              <td className="py-2.5 px-3 font-mono font-medium text-slate-200">
                                <div className="flex items-center gap-1.5">
                                  <span>{order.orderId}</span>
                                  <button
                                    type="button"
                                    onClick={(e) => handleCopyOrderId(order.orderId, e)}
                                    title="Copiar ID"
                                    className="text-slate-500 hover:text-slate-300 p-0.5"
                                  >
                                    {copiedOrderId === order.orderId ? "✓" : "📋"}
                                  </button>
                                </div>
                                {order.isPrime && (
                                  <span className="text-[10px] font-bold text-sky-400 uppercase tracking-wider">
                                    Prime
                                  </span>
                                )}
                              </td>
                              <td className="py-2.5 px-3 text-slate-400 font-mono" title={formatFullDate(order.purchaseDate)}>
                                {formatTime(order.purchaseDate)}
                              </td>
                              <td className="py-2.5 px-3 text-slate-300">
                                {order.salesChannel}
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                <span
                                  className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${
                                    order.fulfillmentChannel === "FBA"
                                      ? "bg-purple-500/10 text-purple-400 border border-purple-500/20"
                                      : "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                                  }`}
                                >
                                  {order.fulfillmentChannel}
                                </span>
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                <span
                                  className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${
                                    order.orderStatus.toLowerCase() === "shipped"
                                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                                      : order.orderStatus.toLowerCase() === "pending"
                                      ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                                      : "bg-slate-800 text-slate-400"
                                  }`}
                                >
                                  {order.orderStatus}
                                </span>
                              </td>
                              <td className="py-2.5 px-3 text-slate-300">
                                <div>{order.shipCity || "-"}</div>
                                {order.shipCountry && (
                                  <div className="text-[10px] text-slate-500">{order.shipCountry}</div>
                                )}
                              </td>
                              <td className="py-2.5 px-3 text-right text-slate-300 font-medium">
                                {order.totalUnits} {order.totalUnits === 1 ? "ud" : "uds"}
                              </td>
                              <td className="py-2.5 px-3 text-right font-semibold text-emerald-400 font-mono">
                                {currencyFull(order.totalRevenue)}
                              </td>
                              <td className="py-2.5 px-3 text-center text-slate-500">
                                <span
                                  className={`inline-block transition-transform ${
                                    isExpanded ? "rotate-180 text-indigo-400" : ""
                                  }`}
                                >
                                  ▼
                                </span>
                              </td>
                            </tr>

                            {/* Sub-table with items inside this order */}
                            {isExpanded && (
                              <tr className="bg-slate-950/80 border-y border-indigo-500/20">
                                <td colSpan={9} className="p-3 pl-8">
                                  <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 space-y-2">
                                    <div className="text-[11px] font-semibold text-indigo-300 uppercase tracking-wider">
                                      Líneas de pedido ({order.items.length})
                                    </div>
                                    <table className="w-full text-xs">
                                      <thead className="text-slate-500 border-b border-slate-800 pb-1 text-[11px]">
                                        <tr>
                                          <th className="py-1 text-left">Producto</th>
                                          <th className="py-1 text-left">SKU / ASIN</th>
                                          <th className="py-1 text-right">Cantidad</th>
                                          <th className="py-1 text-right">Precio Unitario</th>
                                          <th className="py-1 text-right">Envío</th>
                                          <th className="py-1 text-right">Total Línea</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-slate-800/40">
                                        {order.items.map((item, iIdx) => {
                                          const itemSku = maskSku(item.sku);
                                          const itemAsin = maskAsin(item.asin);
                                          const itemName = maskProductName(item.name, item.sku);

                                          return (
                                            <tr key={`${order.orderId}-${item.sku}-${iIdx}`}>
                                              <td className="py-1.5 text-slate-200 max-w-sm truncate" title={itemName}>
                                                {itemName}
                                              </td>
                                              <td className="py-1.5 font-mono text-slate-400 text-[11px]">
                                                <span>{itemSku}</span>
                                                {item.asin && <span className="ml-2 text-slate-500">({itemAsin})</span>}
                                              </td>
                                              <td className="py-1.5 text-right text-slate-300">{item.quantity}</td>
                                              <td className="py-1.5 text-right text-slate-300 font-mono">
                                                {currencyFull(item.itemPrice)}
                                              </td>
                                              <td className="py-1.5 text-right text-slate-400 font-mono">
                                                {item.shippingPrice > 0 ? currencyFull(item.shippingPrice) : "-"}
                                              </td>
                                              <td className="py-1.5 text-right font-semibold text-emerald-400 font-mono">
                                                {currencyFull(item.totalPrice)}
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab 3: Returns */}
          {activeTab === "returns" && (
            <div className="space-y-2">
              <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/40">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-800 bg-slate-950 text-slate-400 font-semibold uppercase tracking-wider">
                    <tr>
                      <th className="py-2.5 px-3">Fecha Devolución</th>
                      <th className="py-2.5 px-3">Pedido Amazon</th>
                      <th className="py-2.5 px-3">Producto / SKU</th>
                      <th className="py-2.5 px-3 text-right">Uds</th>
                      <th className="py-2.5 px-3 text-right">Importe Reembolsado</th>
                      <th className="py-2.5 px-3">Motivo de Devolución</th>
                      <th className="py-2.5 px-3 text-center">Disposición</th>
                      <th className="py-2.5 px-3">Comentarios del Cliente</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {filteredReturns.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-8 text-center text-slate-500">
                          No se registraron devoluciones en este periodo.
                        </td>
                      </tr>
                    ) : (
                      filteredReturns.map((ret, rIdx) => {
                        const rSku = maskSku(ret.sku);
                        const rName = maskProductName(ret.name, ret.sku);

                        return (
                          <tr key={`${ret.orderId}-${ret.sku}-${rIdx}`} className="hover:bg-slate-800/30 transition-colors">
                            <td className="py-2.5 px-3 text-slate-400 font-mono whitespace-nowrap" title={formatFullDate(ret.returnDate)}>
                              <div>{ret.returnDate.slice(0, 10)}</div>
                              <div className="text-[10px] text-slate-500">{formatTime(ret.returnDate)}</div>
                            </td>
                            <td className="py-2.5 px-3 font-mono font-medium text-slate-200 whitespace-nowrap">
                              <div className="flex items-center gap-1.5">
                                <span>{ret.orderId}</span>
                                <button
                                  type="button"
                                  onClick={(e) => handleCopyOrderId(ret.orderId, e)}
                                  title="Copiar ID"
                                  className="text-slate-500 hover:text-slate-300 p-0.5"
                                >
                                  {copiedOrderId === ret.orderId ? "✓" : "📋"}
                                </button>
                              </div>
                              {ret.salesChannel && (
                                <div className="text-[10px] text-slate-500">{ret.salesChannel}</div>
                              )}
                            </td>
                            <td className="py-2.5 px-3 max-w-xs">
                              <div className="font-medium text-slate-200 truncate" title={rName}>
                                {rName}
                              </div>
                              <div className="text-[11px] text-indigo-400 font-mono">{rSku}</div>
                            </td>
                            <td className="py-2.5 px-3 text-right font-bold text-rose-400">
                              -{ret.quantity} ud{ret.quantity > 1 ? "s" : ""}
                            </td>
                            <td className="py-2.5 px-3 text-right font-semibold text-rose-400 font-mono whitespace-nowrap">
                              -{currencyFull(ret.refundAmount)}
                            </td>
                            <td className="py-2.5 px-3">
                              <span className="inline-block px-2 py-0.5 rounded text-[11px] font-medium bg-rose-500/10 text-rose-300 border border-rose-500/20">
                                {ret.reasonLabel}
                              </span>
                              <div className="text-[9px] text-slate-500 font-mono mt-0.5">{ret.reason}</div>
                            </td>
                            <td className="py-2.5 px-3 text-center whitespace-nowrap">
                              <span
                                className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                  ret.detailedDisposition === "SELLABLE"
                                    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                                    : ret.detailedDisposition === "CUSTOMER_DAMAGED"
                                    ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                                    : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                                }`}
                              >
                                {ret.detailedDisposition || "Desconocido"}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 max-w-xs text-slate-300 italic text-[11px]">
                              {ret.customerComments ? (
                                <span className="text-slate-300">&ldquo;{ret.customerComments}&rdquo;</span>
                              ) : (
                                <span className="text-slate-600 font-sans not-italic">Sin comentarios</span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

