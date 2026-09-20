"use client";

import { API_ORIGIN } from "@/lib/apiBase";
import { FormEvent, useEffect, useState } from "react";

type Month = { period: string; totalNet: number; grossShipments: number; totalRefunds: number; serviceFees: number; reimbursements: number; manualExpensesTotal: number; operatingProfit: number };
type Annual = { year: number; months: Month[]; total: Omit<Month, "period"> };
type Expense = { id: string; category: string; description: string; allocationType: string; amount: number | string };
type Summary = { totalNet: number; grossShipments: number; totalRefunds: number; serviceFees: number; reimbursements: number; manualExpensesTotal: number; operatingProfit: number; transactionCount: number; byBreakdown: { label: string; amount: number; count: number }[]; recentTransactions: { id: string; type: string; description: string; amount: number; date: string; orderId?: string }[] };

const money = (value: number) => value.toLocaleString("es-ES", { style: "currency", currency: "EUR" });
const yearNow = new Date().getUTCFullYear();
const monthNow = new Date().toISOString().slice(0, 7);
const rows: Array<[string, keyof Omit<Month, "period">]> = [["Ventas", "grossShipments"], ["Reembolsos", "totalRefunds"], ["Tarifas Amazon", "serviceFees"], ["Indemnizaciones", "reimbursements"], ["Neto Amazon", "totalNet"], ["Gastos externos", "manualExpensesTotal"], ["Beneficio operativo", "operatingProfit"]];

export default function FinancePage() {
  const [year, setYear] = useState(yearNow);
  const [month, setMonth] = useState(monthNow);
  const [annual, setAnnual] = useState<Annual | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ category: "EMBALAJE", description: "", allocationType: "MONTH", amount: "", sku: "" });

  async function load(refresh = false) {
    setLoading(true); setError(null);
    try {
      const query = refresh ? "&refresh=true" : "";
      const [annualResponse, summaryResponse, expensesResponse] = await Promise.all([
        fetch(`${API_ORIGIN}/api/finance/annual?year=${year}${query}`),
        fetch(`${API_ORIGIN}/api/finance/summary?postedAfter=${month}-01T00:00:00.000Z${query}`),
        fetch(`${API_ORIGIN}/api/finance/expenses?period=${month}`),
      ]);
      if (!annualResponse.ok || !summaryResponse.ok || !expensesResponse.ok) throw new Error("No se pudieron cargar los datos financieros");
      setAnnual(await annualResponse.json()); setSummary(await summaryResponse.json()); setExpenses(await expensesResponse.json());
    } catch (e) { setError(e instanceof Error ? e.message : "Error cargando finanzas"); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [year, month]);
  const addExpense = async (event: FormEvent) => { event.preventDefault(); const response = await fetch(`${API_ORIGIN}/api/finance/expenses`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, amount: Number(form.amount), period: month }) }); if (!response.ok) { setError(await response.text()); return; } setForm({ ...form, description: "", amount: "" }); load(true); };
  const deleteExpense = async (id: string) => { await fetch(`${API_ORIGIN}/api/finance/expenses/${id}`, { method: "DELETE" }); load(true); };

  return <main className="p-6 lg:p-10 max-w-[1600px] mx-auto text-slate-100">
    <header className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-2xl font-bold">P&amp;L de Finanzas</h1><p className="text-sm text-slate-400">Vista anual estilo Sellerboard: Amazon + gastos externos</p></div><div className="flex gap-2"><select value={year} onChange={e => { const next = Number(e.target.value); setYear(next); setMonth(`${next}-01`); }} className="field"><option value={yearNow}>{yearNow}</option><option value={yearNow - 1}>{yearNow - 1}</option><option value={yearNow - 2}>{yearNow - 2}</option></select><button onClick={() => load(true)} className="button">Actualizar</button></div></header>
    {error && <p className="mt-5 text-red-400">{error}</p>}{loading && <p className="mt-7 text-slate-400">Consultando Amazon y preparando el P&amp;L…</p>}
    {annual && !loading && <section className="card mt-7 overflow-x-auto"><div className="flex justify-between items-center mb-4"><h2 className="title">P&amp;L mensual {annual.year}</h2><span className="text-xs text-slate-400">Today: {money(annual.months.find(m => m.period === month)?.operatingProfit || 0)}</span></div><table className="annual"><thead><tr><th>Concepto</th>{annual.months.map(m => <th key={m.period}>{new Date(`${m.period}-02T00:00:00Z`).toLocaleDateString("es-ES", { month: "short" })}</th>)}<th>Acumulado</th></tr></thead><tbody>{rows.map(([label, key]) => <tr key={key}><td className="font-medium">{label}</td>{annual.months.map(m => <td key={m.period} className={key === "operatingProfit" ? "font-semibold text-cyan-300" : ""}>{money(Number(m[key] || 0))}</td>)}<td className="font-bold">{money(Number(annual.total[key] || 0))}</td></tr>)}</tbody></table><p className="mt-3 text-xs text-slate-500">La columna Today representa el beneficio operativo del mes seleccionado ({month}). Usa el selector mensual de abajo para cambiarlo.</p></section>}
    {summary && !loading && <><div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mt-7"><section className="card"><h2 className="title">Detalle del mes</h2><select value={month} onChange={e => setMonth(e.target.value)} className="field w-full mb-3">{annual?.months.map(m => <option key={m.period}>{m.period}</option>)}</select>{summary.byBreakdown.map((item, index) => <div className="row" key={`${item.label}-${index}`}><span>{item.label}<small>{item.count} movimientos Amazon</small></span><b className={item.amount < 0 ? "text-rose-400" : "text-emerald-400"}>{money(item.amount)}</b></div>)}</section><section className="card xl:col-span-2"><h2 className="title">Movimientos Amazon ({summary.transactionCount})</h2><div className="max-h-[430px] overflow-auto"><table className="w-full text-xs"><thead><tr><th>Fecha</th><th>Concepto</th><th>Pedido</th><th>Importe</th></tr></thead><tbody>{summary.recentTransactions.map(t => <tr key={t.id}><td>{t.date}</td><td>{t.type}<small>{t.description}</small></td><td>{t.orderId || "-"}</td><td className={t.amount < 0 ? "text-rose-400" : "text-emerald-400"}>{money(t.amount)}</td></tr>)}</tbody></table></div></section></div><section className="card mt-7"><h2 className="title">Gastos externos de {month}</h2><form onSubmit={addExpense} className="grid grid-cols-1 md:grid-cols-6 gap-2"><select className="field" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}><option>EMBALAJE</option><option>COSTE_PRODUCTO</option><option>TRANSPORTE</option><option>MANO_DE_OBRA</option><option>ALMACENAMIENTO</option><option>OTROS</option></select><input required className="field" placeholder="Descripción" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /><select className="field" value={form.allocationType} onChange={e => setForm({ ...form, allocationType: e.target.value })}><option value="MONTH">Mes</option><option value="SKU">SKU</option><option value="ORDER">Pedido</option><option value="UNIT">Unidad</option></select><input required className="field" type="number" step=".01" placeholder="Importe €" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} /><input className="field" placeholder="SKU/pedido" value={form.sku} onChange={e => setForm({ ...form, sku: e.target.value })} /><button className="button bg-emerald-600">Añadir gasto</button></form>{expenses.map(e => <div className="row" key={e.id}><span>{e.category} · {e.description}<small>{e.allocationType}</small></span><span>{money(Number(e.amount))}<button onClick={() => deleteExpense(e.id)} className="ml-4 text-red-400">Eliminar</button></span></div>)}</section></>}
    <style jsx>{`.field{border:1px solid rgb(51 65 85);background:rgb(15 23 42);border-radius:.5rem;padding:.55rem .7rem;color:white}.button{border-radius:.5rem;background:rgb(79 70 229);padding:.55rem .8rem;font-size:.875rem}.card{border:1px solid rgb(30 41 59);background:rgb(15 23 42,.6);border-radius:.75rem;padding:1.25rem}.title{font-weight:600}.annual{min-width:1200px;width:100%;font-size:.75rem;text-align:right}.annual th,.annual td{padding:.65rem;border-bottom:1px solid rgb(30 41 59);white-space:nowrap}.annual th:first-child,.annual td:first-child{text-align:left}.annual th{color:rgb(148 163 184)}.row{display:flex;justify-content:space-between;gap:1rem;border-bottom:1px solid rgb(30 41 59);padding:.6rem 0;font-size:.875rem}.row small,td small{display:block;color:rgb(100 116 139);font-size:.7rem}`}</style>
  </main>;
}
