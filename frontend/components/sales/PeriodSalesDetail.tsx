"use client";

import React, { useMemo, useState } from "react";
import { usePrivacy } from "@/lib/PrivacyContext";

export interface PeriodProductDetail {
  sku: string;
  asin: string;
  name: string;
  units: number;
  revenue: number;
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

export interface PeriodSalesDetailResult {
  start: string;
  end: string;
  channel: string;
  metrics: {
    totalRevenue: number;
    totalUnits: number;
    totalOrders: number;
    avgOrderValue: number;
  };
  products: PeriodProductDetail[];
  orders: PeriodOrderDetail[];
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
  const [activeTab, setActiveTab] = useState<"products" | "orders">("products");
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
            Productos y pedidos registrados en esta fecha para el canal seleccionado.
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
          <span className="text-sm">Cargando productos y pedidos de este periodo...</span>
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
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Facturación
              </span>
              <p className="text-lg font-bold text-emerald-400 mt-0.5">
                {currencyFull(data.metrics.totalRevenue)}
              </p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Unidades Vendidas
              </span>
              <p className="text-lg font-bold text-blue-400 mt-0.5">
                {number(data.metrics.totalUnits)} <span className="text-xs font-normal text-slate-400">uds</span>
              </p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Nº de Pedidos
              </span>
              <p className="text-lg font-bold text-indigo-400 mt-0.5">
                {number(data.metrics.totalOrders)}
              </p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Ticket Medio
              </span>
              <p className="text-lg font-bold text-amber-400 mt-0.5">
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
                <span>Productos Vendidos ({data.products.length})</span>
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
                <span>Listado de Pedidos ({data.orders.length})</span>
              </button>
            </div>

            <div className="relative w-full sm:w-64">
              <input
                type="text"
                placeholder={activeTab === "products" ? "Filtrar por SKU, ASIN, título..." : "Buscar pedido, ciudad..."}
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
                    <th className="py-2.5 px-3 text-right">Uds</th>
                    <th className="py-2.5 px-3 text-right">Precio Medio</th>
                    <th className="py-2.5 px-3 text-right">Total Facturado</th>
                    <th className="py-2.5 px-3 text-right">Pedidos</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filteredProducts.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-500">
                        No se encontraron productos coincidentes.
                      </td>
                    </tr>
                  ) : (
                    filteredProducts.map((prod, idx) => {
                      const sharePct =
                        data.metrics.totalRevenue > 0
                          ? ((prod.revenue / data.metrics.totalRevenue) * 100).toFixed(1)
                          : "0";
                      const displaySku = maskSku(prod.sku);
                      const displayAsin = maskAsin(prod.asin);
                      const displayName = maskProductName(prod.name, prod.sku);

                      return (
                        <tr key={prod.sku} className="hover:bg-slate-800/30 transition-colors">
                          <td className="py-2.5 px-3 text-center font-bold text-slate-500">
                            {idx + 1}
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="font-medium text-slate-200 line-clamp-1" title={displayName}>
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
                            <div>{number(prod.units)}</div>
                            <div className="w-16 ml-auto mt-1 h-1 rounded-full bg-slate-800 overflow-hidden">
                              <div
                                className="h-full bg-blue-500 rounded-full"
                                style={{
                                  width: `${Math.min(
                                    100,
                                    (prod.units / Math.max(1, data.metrics.totalUnits)) * 100
                                  )}%`,
                                }}
                              />
                            </div>
                          </td>
                          <td className="py-2.5 px-3 text-right text-slate-400 font-mono">
                            {currencyFull(prod.avgPrice)}
                          </td>
                          <td className="py-2.5 px-3 text-right font-semibold text-emerald-400 font-mono">
                            <div>{currencyFull(prod.revenue)}</div>
                            <div className="text-[10px] text-slate-500 font-sans font-normal">
                              {sharePct}% del día
                            </div>
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
        </>
      )}
    </div>
  );
}
