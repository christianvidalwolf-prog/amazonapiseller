"use client";

import { useEffect, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface TransactionRow {
  id: string;
  type: string;
  description: string;
  amount: number;
  currency: string;
  date: string;
  orderId?: string;
}

interface FinanceSummary {
  periodStart: string;
  totalNet: number;
  grossShipments: number;
  totalRefunds: number;
  reimbursements: number;
  serviceFees: number;
  transfers: number;
  otherAdjustments: number;
  byType: Array<{ type: string; label: string; amount: number; count: number }>;
  recentTransactions: TransactionRow[];
}

const currency = (val: number) =>
  val.toLocaleString("es-ES", { style: "currency", currency: "EUR" });

export default function FinancePage() {
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchFinance = (force = false) => {
    if (force) setRefreshing(true);
    else setLoading(true);

    fetch(`${API_URL}/api/finance/summary${force ? "?refresh=true" : ""}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(setSummary)
      .catch((err) => setError(err instanceof Error ? err.message : "Error cargando finanzas"))
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  };

  useEffect(() => {
    fetchFinance();
  }, []);

  return (
    <main className="p-10 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Finanzas y Liquidaciones</h1>
          <p className="mt-1 text-sm text-slate-400">
            Datos en tiempo real extraídos mediante Amazon Finances API (v2024).
          </p>
        </div>
        <button
          onClick={() => fetchFinance(true)}
          disabled={loading || refreshing}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 transition-colors disabled:opacity-50"
        >
          {refreshing ? "Sincronizando..." : "↻ Actualizar con Amazon"}
        </button>
      </div>

      {loading && <p className="mt-6 text-slate-400">Consultando transacciones financieras con Amazon…</p>}
      {error && <p className="mt-6 text-red-400">Error: {error}</p>}

      {summary && !loading && (
        <>
          {/* Tarjetas KPI principales */}
          <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-5 shadow-sm">
              <span className="text-xs font-medium text-emerald-400 uppercase tracking-wider">
                Saldo Neto Liquidable
              </span>
              <p className="mt-2 text-3xl font-extrabold text-emerald-400">
                {currency(summary.totalNet)}
              </p>
              <p className="mt-1 text-xs text-slate-400">Disponible para desembolso a tu cuenta</p>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 shadow-sm">
              <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Ventas y Envíos
              </span>
              <p className="mt-2 text-2xl font-bold text-slate-100">
                {currency(summary.grossShipments)}
              </p>
              <p className="mt-1 text-xs text-slate-500">Ingresos brutos por pedidos confirmados</p>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 shadow-sm">
              <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Reembolsos a Clientes
              </span>
              <p className="mt-2 text-2xl font-bold text-red-400">
                {currency(summary.totalRefunds)}
              </p>
              <p className="mt-1 text-xs text-slate-500">Devoluciones procesadas en el periodo</p>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 shadow-sm">
              <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Transferencias a Banco
              </span>
              <p className="mt-2 text-2xl font-bold text-blue-400">
                {currency(summary.transfers)}
              </p>
              <p className="mt-1 text-xs text-slate-500">Liquidaciones bancarias emitidas</p>
            </div>
          </div>

          {/* Desglose por tipo y transacciones */}
          <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Desglose contable */}
            <div className="lg:col-span-1 rounded-xl border border-slate-800 bg-slate-900/40 p-6">
              <h2 className="text-base font-semibold text-slate-100 mb-4">
                Desglose por Concepto Contable
              </h2>
              <ul className="divide-y divide-slate-800/80">
                {summary.byType.map((item) => (
                  <li key={item.type} className="py-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-slate-200">{item.label}</p>
                      <p className="text-xs text-slate-500">{item.count} transacciones</p>
                    </div>
                    <span
                      className={`font-semibold text-sm ${
                        item.amount > 0
                          ? "text-emerald-400"
                          : item.amount < 0
                          ? "text-rose-400"
                          : "text-slate-400"
                      }`}
                    >
                      {item.amount > 0 ? `+${currency(item.amount)}` : currency(item.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Tabla de movimientos recientes */}
            <div className="lg:col-span-2 rounded-xl border border-slate-800 bg-slate-900/40 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-base font-semibold text-slate-100">
                  Últimos Movimientos Financieros
                </h2>
                <span className="text-xs text-slate-400">
                  {summary.recentTransactions.length} registros recientes
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-slate-800 bg-slate-900/80 text-slate-400">
                    <tr>
                      <th className="py-2.5 px-3 font-medium">Fecha</th>
                      <th className="py-2.5 px-3 font-medium">Concepto</th>
                      <th className="py-2.5 px-3 font-medium">ID Pedido / Ref</th>
                      <th className="py-2.5 px-3 font-medium text-right">Importe</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {summary.recentTransactions.slice(0, 20).map((t, idx) => (
                      <tr key={t.id || idx} className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-2.5 px-3 text-xs text-slate-400 whitespace-nowrap">{t.date}</td>
                        <td className="py-2.5 px-3 text-xs text-slate-200">
                          <span className="font-medium text-slate-300">{t.type}</span>
                          {t.description && t.description !== t.type && (
                            <span className="block text-[11px] text-slate-500 truncate max-w-xs">{t.description}</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-xs text-indigo-300">
                          {t.orderId || "-"}
                        </td>
                        <td
                          className={`py-2.5 px-3 text-right font-semibold text-xs whitespace-nowrap ${
                            t.amount > 0
                              ? "text-emerald-400"
                              : t.amount < 0
                              ? "text-rose-400"
                              : "text-slate-400"
                          }`}
                        >
                          {t.amount > 0 ? `+${currency(t.amount)}` : currency(t.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
