"use client";

import { API_ORIGIN } from "@/lib/apiBase";
import { FormEvent, useEffect, useState } from "react";

type Month = {
  period: string;
  totalNet: number;
  grossShipments: number;
  totalRefunds: number;
  serviceFees: number;
  reimbursements: number;
  manualExpensesTotal: number;
  operatingProfit: number;
};
type Annual = { year: number; months: Month[]; total: Omit<Month, "period"> };
type Expense = { id: string; category: string; description: string; allocationType: string; amount: number | string };
type Summary = {
  totalNet: number;
  grossShipments: number;
  totalRefunds: number;
  serviceFees: number;
  reimbursements: number;
  manualExpensesTotal: number;
  operatingProfit: number;
  transactionCount: number;
  byBreakdown: { label: string; amount: number; count: number }[];
  pnl?: { key: string; label: string; amount: number; count: number; children: { key: string; label: string; amount: number; count: number }[] }[];
  recentTransactions: { id: string; type: string; description: string; amount: number; date: string; orderId?: string }[];
};

const money = (value: number) => value.toLocaleString("es-ES", { style: "currency", currency: "EUR" });
const yearNow = new Date().getUTCFullYear();
const monthNow = new Date().toISOString().slice(0, 7);
const rows: Array<[string, keyof Omit<Month, "period">]> = [
  ["Ventas", "grossShipments"],
  ["Reembolsos", "totalRefunds"],
  ["Tarifas Amazon", "serviceFees"],
  ["Indemnizaciones", "reimbursements"],
  ["Neto Amazon", "totalNet"],
  ["Gastos externos", "manualExpensesTotal"],
  ["Beneficio operativo", "operatingProfit"],
];

export default function FinancePage() {
  const [year, setYear] = useState(yearNow);
  const [month, setMonth] = useState(monthNow);
  const [annual, setAnnual] = useState<Annual | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ category: "EMBALAJE", description: "", allocationType: "MONTH", amount: "", sku: "" });
  const [submittingExpense, setSubmittingExpense] = useState(false);

  async function load(refresh = false) {
    setLoading(true);
    setError(null);
    try {
      const query = refresh ? "&refresh=true" : "";
      const [annualRes, summaryRes, expensesRes] = await Promise.allSettled([
        fetch(`${API_ORIGIN}/api/finance/annual?year=${year}${query}`),
        fetch(`${API_ORIGIN}/api/finance/summary?postedAfter=${month}-01T00:00:00.000Z${query}`),
        fetch(`${API_ORIGIN}/api/finance/expenses?period=${month}`),
      ]);

      let loadedSomething = false;

      let loadedAnnual = false;
      if (annualRes.status === "fulfilled" && annualRes.value.ok) {
        try {
          const annualData = await annualRes.value.json();
          if (annualData && Array.isArray(annualData.months)) {
            setAnnual(annualData);
            loadedSomething = true;
            loadedAnnual = true;
          }
        } catch {}
      }

      let loadedSummary: Summary | null = null;
      if (summaryRes.status === "fulfilled" && summaryRes.value.ok) {
        try {
          const summaryData = await summaryRes.value.json();
          if (summaryData && typeof summaryData.totalNet === "number") {
            setSummary(summaryData);
            loadedSomething = true;
            loadedSummary = summaryData;
          }
        } catch {}
      }

      if (!loadedAnnual && loadedSummary) {
        const fallbackMonth: Month = {
          period: month,
          totalNet: loadedSummary.totalNet,
          grossShipments: loadedSummary.grossShipments,
          totalRefunds: loadedSummary.totalRefunds,
          serviceFees: loadedSummary.serviceFees,
          reimbursements: loadedSummary.reimbursements,
          manualExpensesTotal: loadedSummary.manualExpensesTotal,
          operatingProfit: loadedSummary.operatingProfit,
        };
        setAnnual({
          year,
          months: [fallbackMonth],
          total: fallbackMonth,
        });
      }

      if (expensesRes.status === "fulfilled" && expensesRes.value.ok) {
        try {
          const expensesData = await expensesRes.value.json();
          if (Array.isArray(expensesData)) {
            setExpenses(expensesData);
          } else {
            setExpenses([]);
          }
        } catch {
          setExpenses([]);
        }
      } else {
        setExpenses([]);
      }

      if (!loadedSomething) {
        setError("No se pudieron cargar los datos financieros. Comprueba la conexión o ejecuta la sincronización de datos.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error cargando finanzas");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [year, month]);

  const addExpense = async (event: FormEvent) => {
    event.preventDefault();
    setSubmittingExpense(true);
    try {
      const response = await fetch(`${API_ORIGIN}/api/finance/expenses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, amount: Number(form.amount), period: month }),
      });
      if (!response.ok) {
        const errText = await response.text();
        setError(`No se pudo añadir el gasto: ${errText}`);
        return;
      }
      setForm({ ...form, description: "", amount: "", sku: "" });
      load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al guardar el gasto");
    } finally {
      setSubmittingExpense(false);
    }
  };

  const deleteExpense = async (id: string) => {
    try {
      await fetch(`${API_ORIGIN}/api/finance/expenses/${id}`, { method: "DELETE" });
      load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al eliminar el gasto");
    }
  };

  const currentMonthProfit = annual?.months.find((m) => m.period === month)?.operatingProfit ?? summary?.operatingProfit ?? 0;

  return (
    <main className="p-6 lg:p-10 max-w-[1600px] mx-auto text-slate-100">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">P&amp;L de Finanzas</h1>
          <p className="text-sm text-slate-400">Vista anual estilo Sellerboard: liquidaciones Amazon + gastos externos</p>
        </div>
        <div className="flex gap-2">
          <select
            value={year}
            onChange={(e) => {
              const next = Number(e.target.value);
              setYear(next);
              setMonth(`${next}-01`);
            }}
            className="field"
          >
            <option value={yearNow}>{yearNow}</option>
            <option value={yearNow - 1}>{yearNow - 1}</option>
            <option value={yearNow - 2}>{yearNow - 2}</option>
          </select>
          <button onClick={() => load(true)} disabled={loading} className="button hover:bg-indigo-500 transition-colors">
            {loading ? "Actualizando…" : "Actualizar"}
          </button>
        </div>
      </header>

      {error && (
        <div className="mt-5 p-3 rounded-lg bg-red-900/40 border border-red-700/50 text-red-300 text-sm">
          {error}
        </div>
      )}

      {loading && !annual && !summary && (
        <div className="mt-12 flex flex-col items-center justify-center gap-3 text-slate-400">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
          <p>Consultando Amazon y preparando el P&amp;L…</p>
        </div>
      )}

      {annual && (
        <section className="card mt-7 overflow-x-auto">
          <div className="flex justify-between items-center mb-4">
            <h2 className="title">P&amp;L mensual {annual.year}</h2>
            <span className="text-xs text-slate-400">
              Beneficio {month}: <strong className="text-cyan-300">{money(currentMonthProfit)}</strong>
            </span>
          </div>
          <table className="annual">
            <thead>
              <tr>
                <th>Concepto</th>
                {annual.months.map((m) => (
                  <th key={m.period}>
                    {new Date(`${m.period}-02T00:00:00Z`).toLocaleDateString("es-ES", { month: "short" })}
                  </th>
                ))}
                <th>Acumulado</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, key]) => (
                <tr key={key}>
                  <td className="font-medium">{label}</td>
                  {annual.months.map((m) => (
                    <td key={m.period} className={key === "operatingProfit" ? "font-semibold text-cyan-300" : ""}>
                      {money(Number(m[key] || 0))}
                    </td>
                  ))}
                  <td className="font-bold">{money(Number(annual.total[key] || 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-slate-500">
            La tabla anual refleja las liquidaciones oficiales registradas por Amazon. Usa el selector inferior para desglosar cualquier mes.
          </p>
        </section>
      )}

      {summary && (
        <>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mt-7">
            <section className="card">
              <div className="flex justify-between items-center mb-3">
                <h2 className="title">Detalle de {month}</h2>
                <select value={month} onChange={(e) => setMonth(e.target.value)} className="field text-xs py-1">
                  {annual?.months.map((m) => (
                    <option key={m.period} value={m.period}>
                      {m.period}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mb-5 border-b border-slate-800 pb-3">
                <h3 className="text-sm font-semibold mb-2">P&amp;L desglosada</h3>
                {(summary.pnl ?? []).length > 0 ? (summary.pnl ?? []).map((group) => (
                  <div key={group.key} className="mb-3">
                    <div className="row font-medium">
                      <span>{group.label}<small>{group.count} movimientos</small></span>
                      <b className={group.amount < 0 ? "text-rose-400" : "text-emerald-400"}>{money(group.amount)}</b>
                    </div>
                    {group.children.slice(0, 12).map((child) => (
                      <div className="row pl-3 text-xs text-slate-400" key={`${group.key}-${child.key}`}>
                        <span>{child.label}</span>
                        <span>{money(child.amount)}</span>
                      </div>
                    ))}
                  </div>
                )) : <p className="text-xs text-slate-500">Sin movimientos desglosados.</p>}
              </div>
              <div className="space-y-1">
                {summary.byBreakdown.length > 0 ? (
                  summary.byBreakdown.map((item, index) => (
                    <div className="row" key={`${item.label}-${index}`}>
                      <span>
                        {item.label}
                        <small>{item.count} movimientos Amazon</small>
                      </span>
                      <b className={item.amount < 0 ? "text-rose-400" : "text-emerald-400"}>{money(item.amount)}</b>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-slate-500 py-4">No hay desglose de comisiones para este mes.</p>
                )}
              </div>
            </section>

            <section className="card xl:col-span-2">
              <h2 className="title">Movimientos Amazon ({summary.transactionCount})</h2>
              <div className="max-h-[430px] overflow-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Concepto</th>
                      <th>Pedido</th>
                      <th>Importe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.recentTransactions.length > 0 ? (
                      summary.recentTransactions.map((t) => (
                        <tr key={t.id}>
                          <td>{t.date}</td>
                          <td>
                            {t.type}
                            <small>{t.description}</small>
                          </td>
                          <td>{t.orderId || "-"}</td>
                          <td className={t.amount < 0 ? "text-rose-400" : "text-emerald-400"}>{money(t.amount)}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={4} className="text-center text-slate-500 py-4">
                          No se registraron transacciones recientes en este periodo.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <section className="card mt-7">
            <h2 className="title">Gastos externos de {month}</h2>
            <form onSubmit={addExpense} className="grid grid-cols-1 md:grid-cols-6 gap-2 mt-3">
              <select className="field" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                <option value="EMBALAJE">EMBALAJE</option>
                <option value="COSTE_PRODUCTO">COSTE_PRODUCTO</option>
                <option value="TRANSPORTE">TRANSPORTE</option>
                <option value="MANO_DE_OBRA">MANO_DE_OBRA</option>
                <option value="ALMACENAMIENTO">ALMACENAMIENTO</option>
                <option value="OTROS">OTROS</option>
              </select>
              <input
                required
                className="field"
                placeholder="Descripción"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
              <select className="field" value={form.allocationType} onChange={(e) => setForm({ ...form, allocationType: e.target.value })}>
                <option value="MONTH">Mes</option>
                <option value="SKU">SKU</option>
                <option value="ORDER">Pedido</option>
                <option value="UNIT">Unidad</option>
              </select>
              <input
                required
                className="field"
                type="number"
                step=".01"
                placeholder="Importe €"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
              <input
                className="field"
                placeholder="SKU/pedido (opcional)"
                value={form.sku}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
              />
              <button disabled={submittingExpense} className="button bg-emerald-600 hover:bg-emerald-500 transition-colors font-medium">
                {submittingExpense ? "Añadiendo…" : "Añadir gasto"}
              </button>
            </form>

            <div className="mt-4 divide-y divide-slate-800">
              {expenses.length > 0 ? (
                expenses.map((e) => (
                  <div className="row" key={e.id}>
                    <span>
                      {e.category} · {e.description}
                      <small>{e.allocationType}</small>
                    </span>
                    <span>
                      {money(Number(e.amount))}
                      <button onClick={() => deleteExpense(e.id)} className="ml-4 text-red-400 hover:text-red-300">
                        Eliminar
                      </button>
                    </span>
                  </div>
                ))
              ) : (
                <p className="text-xs text-slate-500 pt-2">No hay gastos externos registrados para este mes.</p>
              )}
            </div>
          </section>
        </>
      )}

      <style jsx>{`
        .field {
          border: 1px solid rgb(51 65 85);
          background: rgb(15 23 42);
          border-radius: 0.5rem;
          padding: 0.55rem 0.7rem;
          color: white;
        }
        .button {
          border-radius: 0.5rem;
          background: rgb(79 70 229);
          padding: 0.55rem 0.8rem;
          font-size: 0.875rem;
        }
        .card {
          border: 1px solid rgb(30 41 59);
          background: rgba(15, 23, 42, 0.6);
          border-radius: 0.75rem;
          padding: 1.25rem;
        }
        .title {
          font-weight: 600;
        }
        .annual {
          min-width: 1200px;
          width: 100%;
          font-size: 0.75rem;
          text-align: right;
        }
        .annual th,
        .annual td {
          padding: 0.65rem;
          border-bottom: 1px solid rgb(30 41 59);
          white-space: nowrap;
        }
        .annual th:first-child,
        .annual td:first-child {
          text-align: left;
        }
        .annual th {
          color: rgb(148 163 184);
        }
        .row {
          display: flex;
          justify-content: space-between;
          gap: 1rem;
          border-bottom: 1px solid rgb(30 41 59);
          padding: 0.6rem 0;
          font-size: 0.875rem;
        }
        .row small,
        td small {
          display: block;
          color: rgb(100 116 139);
          font-size: 0.7rem;
        }
      `}</style>
    </main>
  );
}
