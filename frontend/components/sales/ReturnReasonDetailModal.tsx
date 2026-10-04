"use client";

import React, { useMemo, useState } from "react";
import { usePrivacy } from "@/lib/PrivacyContext";
import type { PeriodReturnDetail } from "./PeriodSalesDetail";

export interface ReturnReasonSummary {
  reason: string;
  label: string;
  count: number;
  units: number;
  revenue: number;
}

interface Props {
  reasonSummary: ReturnReasonSummary;
  returns: PeriodReturnDetail[];
  periodLabel: string;
  channel: string;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
}

const currencyFull = (value: number) =>
  value.toLocaleString("es-ES", { style: "currency", currency: "EUR" });
const number = (value: number) => value.toLocaleString("es-ES");

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

export function ReturnReasonDetailModal({
  reasonSummary,
  returns,
  periodLabel,
  channel,
  loading = false,
  error = null,
  onClose,
}: Props) {
  const { maskProductName, maskSku } = usePrivacy();
  const [activeTab, setActiveTab] = useState<"products" | "orders">("products");
  const [searchTerm, setSearchTerm] = useState("");
  const [copiedOrderId, setCopiedOrderId] = useState<string | null>(null);

  const handleCopyOrderId = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(id);
    setCopiedOrderId(id);
    setTimeout(() => setCopiedOrderId(null), 2000);
  };

  // Filter returns matching this reason
  const reasonReturns = useMemo(() => {
    return (returns || []).filter(
      (r) =>
        r.reason.toLowerCase() === reasonSummary.reason.toLowerCase() ||
        (reasonSummary.label && r.reasonLabel.toLowerCase() === reasonSummary.label.toLowerCase())
    );
  }, [returns, reasonSummary]);

  // Aggregate products returned under this reason
  const aggregatedProducts = useMemo(() => {
    const map = new Map<
      string,
      {
        sku: string;
        asin: string;
        name: string;
        units: number;
        refundAmount: number;
        orderIds: Set<string>;
      }
    >();

    for (const r of reasonReturns) {
      const existing = map.get(r.sku) ?? {
        sku: r.sku,
        asin: r.asin,
        name: r.name,
        units: 0,
        refundAmount: 0,
        orderIds: new Set<string>(),
      };
      existing.units += r.quantity || 1;
      existing.refundAmount += r.refundAmount || 0;
      existing.orderIds.add(r.orderId);
      map.set(r.sku, existing);
    }

    return Array.from(map.values())
      .map((p) => ({
        ...p,
        refundAmount: Number(p.refundAmount.toFixed(2)),
        orderCount: p.orderIds.size,
      }))
      .sort((a, b) => b.units - a.units || b.refundAmount - a.refundAmount);
  }, [reasonReturns]);

  // Apply search filter
  const filteredProducts = useMemo(() => {
    if (!searchTerm.trim()) return aggregatedProducts;
    const term = searchTerm.toLowerCase();
    return aggregatedProducts.filter(
      (p) =>
        p.sku.toLowerCase().includes(term) ||
        p.asin.toLowerCase().includes(term) ||
        p.name.toLowerCase().includes(term)
    );
  }, [aggregatedProducts, searchTerm]);

  const filteredOrders = useMemo(() => {
    if (!searchTerm.trim()) return reasonReturns;
    const term = searchTerm.toLowerCase();
    return reasonReturns.filter(
      (r) =>
        r.orderId.toLowerCase().includes(term) ||
        r.sku.toLowerCase().includes(term) ||
        r.asin.toLowerCase().includes(term) ||
        r.name.toLowerCase().includes(term) ||
        (r.customerComments && r.customerComments.toLowerCase().includes(term)) ||
        (r.salesChannel && r.salesChannel.toLowerCase().includes(term))
    );
  }, [reasonReturns, searchTerm]);

  const totalRefunded = reasonReturns.reduce((sum, r) => sum + (r.refundAmount || 0), 0);
  const totalUnits = reasonReturns.reduce((sum, r) => sum + (r.quantity || 1), 0);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-return-reason-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200"
    >
      <div className="relative w-full max-w-5xl max-h-[90vh] flex flex-col rounded-2xl border border-rose-500/30 bg-slate-900 shadow-2xl overflow-hidden">
        {/* Top Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-5 sm:px-6 border-b border-slate-800 bg-slate-950/60">
          <div>
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wider bg-rose-500/10 text-rose-400 border border-rose-500/30">
                Motivo de Devolución
              </span>
              <span className="text-xs text-slate-400 font-mono">
                {periodLabel} • {channel === "ALL" ? "Todos los canales" : channel}
              </span>
            </div>
            <h2 id="modal-return-reason-title" className="text-lg sm:text-xl font-bold text-slate-100 mt-1 flex items-center gap-2">
              <span>{reasonSummary.label}</span>
              <span className="text-xs font-mono font-normal text-slate-500">
                ({reasonSummary.reason})
              </span>
            </h2>
          </div>

          <div className="flex items-center gap-2 self-end sm:self-auto">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white text-xs font-medium transition-colors flex items-center gap-1.5"
            >
              <span>✕</span> Cerrar
            </button>
          </div>
        </div>

        {/* Quick Metrics Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4 sm:px-6 bg-slate-950/30 border-b border-slate-800/80">
          <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Unidades Devueltas
            </span>
            <p className="text-base sm:text-lg font-bold text-rose-400 mt-0.5 font-mono">
              -{number(totalUnits || reasonSummary.units)} uds
            </p>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Importe Reembolsado
            </span>
            <p className="text-base sm:text-lg font-bold text-rose-400 mt-0.5 font-mono">
              -{currencyFull(totalRefunded || reasonSummary.revenue)}
            </p>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Productos Afectados
            </span>
            <p className="text-base sm:text-lg font-bold text-indigo-400 mt-0.5 font-mono">
              {aggregatedProducts.length} SKUs
            </p>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Pedidos Afectados
            </span>
            <p className="text-base sm:text-lg font-bold text-amber-400 mt-0.5 font-mono">
              {reasonReturns.length} eventos
            </p>
          </div>
        </div>

        {/* Tabs and Search Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-5 py-3 border-b border-slate-800 bg-slate-900">
          <div className="inline-flex rounded-lg border border-slate-800 bg-slate-950 p-1 text-xs">
            <button
              type="button"
              onClick={() => setActiveTab("products")}
              className={`rounded-md px-3 py-1.5 font-medium transition-colors flex items-center gap-1.5 ${
                activeTab === "products"
                  ? "bg-rose-600 text-white shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <span>📦</span>
              <span>Productos Afectados ({aggregatedProducts.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("orders")}
              className={`rounded-md px-3 py-1.5 font-medium transition-colors flex items-center gap-1.5 ${
                activeTab === "orders"
                  ? "bg-rose-600 text-white shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <span>🛒</span>
              <span>Pedidos y Devoluciones ({reasonReturns.length})</span>
            </button>
          </div>

          <div className="relative">
            <input
              type="text"
              placeholder={activeTab === "products" ? "Filtrar por SKU o título..." : "Filtrar por pedido, SKU o comentario..."}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full sm:w-64 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-rose-500 focus:outline-none"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Content Body */}
        <div className="overflow-y-auto flex-1 p-4 sm:p-6 space-y-4">
          {loading && (
            <div className="flex items-center justify-center gap-3 py-16 text-slate-400">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-rose-400" />
              <span className="text-sm">Cargando desglose de pedidos y productos para este motivo...</span>
            </div>
          )}

          {error && !loading && (
            <div className="rounded-lg border border-rose-800 bg-rose-950/40 p-4 text-xs text-rose-300">
              {error}
            </div>
          )}

          {!loading && !error && (
            <>
              {activeTab === "products" && (
                <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/40">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-800 bg-slate-950 text-slate-400 font-semibold uppercase tracking-wider">
                      <tr>
                        <th className="py-2.5 px-3">Producto</th>
                        <th className="py-2.5 px-3">SKU / ASIN</th>
                        <th className="py-2.5 px-3 text-right">Uds Devueltas</th>
                        <th className="py-2.5 px-3 text-right">Importe Reembolsado</th>
                        <th className="py-2.5 px-3 text-right">Pedidos</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {filteredProducts.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-slate-500">
                            {aggregatedProducts.length === 0
                              ? "No se encontraron devoluciones registradas con este motivo en el desglose disponible."
                              : "No hay productos que coincidan con la búsqueda."}
                          </td>
                        </tr>
                      ) : (
                        filteredProducts.map((p, idx) => {
                          const pSku = maskSku(p.sku);
                          const pName = maskProductName(p.name, p.sku);

                          return (
                            <tr key={`${p.sku}-${idx}`} className="hover:bg-slate-800/30 transition-colors">
                              <td className="py-2.5 px-3 max-w-md">
                                <div className="font-medium text-slate-200 truncate" title={pName}>
                                  {pName}
                                </div>
                              </td>
                              <td className="py-2.5 px-3 font-mono text-slate-400 text-[11px] whitespace-nowrap">
                                <span className="text-indigo-400 font-semibold">{pSku}</span>
                                {p.asin && <span className="ml-2 text-slate-500">({p.asin})</span>}
                              </td>
                              <td className="py-2.5 px-3 text-right font-bold text-rose-400 font-mono">
                                -{p.units} ud{p.units > 1 ? "s" : ""}
                              </td>
                              <td className="py-2.5 px-3 text-right font-semibold text-rose-400 font-mono whitespace-nowrap">
                                -{currencyFull(p.refundAmount)}
                              </td>
                              <td className="py-2.5 px-3 text-right text-slate-300 font-mono">
                                {p.orderCount}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {activeTab === "orders" && (
                <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/40">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-800 bg-slate-950 text-slate-400 font-semibold uppercase tracking-wider">
                      <tr>
                        <th className="py-2.5 px-3">Fecha</th>
                        <th className="py-2.5 px-3">Pedido Amazon</th>
                        <th className="py-2.5 px-3">Producto / SKU</th>
                        <th className="py-2.5 px-3 text-right">Uds</th>
                        <th className="py-2.5 px-3 text-right">Reembolsado</th>
                        <th className="py-2.5 px-3 text-center">Disposición</th>
                        <th className="py-2.5 px-3">Comentarios del Cliente</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {filteredOrders.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="py-8 text-center text-slate-500">
                            {reasonReturns.length === 0
                              ? "No se encontraron devoluciones registradas con este motivo en el desglose disponible."
                              : "No hay pedidos que coincidan con la búsqueda."}
                          </td>
                        </tr>
                      ) : (
                        filteredOrders.map((ret, rIdx) => {
                          const rSku = maskSku(ret.sku);
                          const rName = maskProductName(ret.name, ret.sku);

                          return (
                            <tr key={`${ret.orderId}-${ret.sku}-${rIdx}`} className="hover:bg-slate-800/30 transition-colors">
                              <td className="py-2.5 px-3 text-slate-400 font-mono whitespace-nowrap" title={formatFullDate(ret.returnDate)}>
                                <div>{ret.returnDate.slice(0, 10)}</div>
                              </td>
                              <td className="py-2.5 px-3 font-mono font-medium text-slate-200 whitespace-nowrap">
                                <div className="flex items-center gap-1.5">
                                  <span>{ret.orderId}</span>
                                  <button
                                    type="button"
                                    onClick={(e) => handleCopyOrderId(ret.orderId, e)}
                                    title="Copiar ID de Pedido"
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
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 sm:px-6 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between text-xs text-slate-400">
          <span>
            Mostrando información consolidada de devoluciones de Amazon SP-API.
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium transition-colors"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
