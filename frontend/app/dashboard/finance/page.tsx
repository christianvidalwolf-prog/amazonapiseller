"use client";

import { type FormEvent, Fragment, useEffect, useState } from "react";
import { API_ORIGIN } from "@/lib/apiBase";

type Month = {
  period: string;
  totalNet: number;
  grossShipments: number;
  totalRefunds: number;
  serviceFees: number;
  reimbursements: number;
  manualExpensesTotal: number;
  operatingProfit: number;
  pnl?: PnlGroup[];
};
type PnlChild = { key: string; label: string; amount: number; count: number };
type PnlGroup = { key: string; label: string; amount: number; count: number; children: PnlChild[] };
type Annual = { year: number; months: Month[]; total: Omit<Month, "period"> };
type Expense = { id: string; category: string; description: string; allocationType: string; amount: number | string };
type CostRecord = {
  sku: string;
  cost: number | null;
  vat: number | null;
  asin?: string;
  title?: string;
  marketplace?: string;
  costPeriodStartDate?: string;
  domesticShippingCost: number | null;
  restofworldShippingCost: number | null;
  sourceFile?: string;
};
type CostsMeta = { rowCount: number; skuCount: number; chunkCount: number; missingChunks: number[]; generatedAt: string; importedAt?: string; source?: string };
type MarginInfo = {
  sku: string;
  price: number | null;
  landedCost: number | null;
  margin: number | null;
  marginPct: number | null;
  fees: { total: number | null; referral: number | null; fulfillment: number | null };
  error: string | null;
};
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

const detailedRows = (months: Month[]) => {
  const groups = new Map<string, { label: string; amounts: number[]; children: Map<string, { label: string; amounts: number[] }> }>();
  months.forEach((month, monthIndex) => (month.pnl ?? []).forEach((group) => {
    const target = groups.get(group.key) ?? { label: group.label, amounts: Array(months.length).fill(0), children: new Map() };
    target.amounts[monthIndex] += Number(group.amount || 0);
    group.children.forEach((child) => {
      const childTarget = target.children.get(child.key) ?? { label: child.label, amounts: Array(months.length).fill(0) };
      childTarget.amounts[monthIndex] += Number(child.amount || 0);
      target.children.set(child.key, childTarget);
    });
    groups.set(group.key, target);
  }));
  return Array.from(groups.entries()).map(([key, value]) => ({ key, ...value, children: Array.from(value.children.entries()).map(([childKey, child]) => ({ key: childKey, ...child })) }));
};

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
  const [costQuery, setCostQuery] = useState("");
  const [costResults, setCostResults] = useState<CostRecord[]>([]);
  const [costMargin, setCostMargin] = useState<MarginInfo | null>(null);
  const [costMarginUpdatedAt, setCostMarginUpdatedAt] = useState<string | null>(null);
  const [costMeta, setCostMeta] = useState<CostsMeta | null>(null);
  const [searchingCost, setSearchingCost] = useState(false);
  const [costMessage, setCostMessage] = useState<string | null>(null);

  async function load(refresh = false) {
    setLoading(true);
    setError(null);
    try {
      const query = refresh ? "&refresh=true" : "";
      const [annualRes, summaryRes, expensesRes, costsRes] = await Promise.allSettled([
        fetch(`${API_ORIGIN}/api/finance/annual?year=${year}${query}`),
        fetch(`${API_ORIGIN}/api/finance/summary?postedAfter=${month}-01T00:00:00.000Z${query}`),
        fetch(`${API_ORIGIN}/api/finance/expenses?period=${month}`),
        fetch(`${API_ORIGIN}/api/finance/costs`),
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

      if (costsRes.status === "fulfilled" && costsRes.value.ok) {
        try {
          const costsData = await costsRes.value.json();
          if (costsData && typeof costsData.rowCount === "number") {
            setCostMeta(costsData);
          } else {
            setCostMeta(null);
          }
        } catch {
          setCostMeta(null);
        }
      } else {
        setCostMeta(null);
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

  const searchCosts = async (event: FormEvent) => {
    event.preventDefault();
    const sku = costQuery.trim();
    if (!sku) return;
    setSearchingCost(true);
    setCostMessage(null);
    try {
      const response = await fetch(`${API_ORIGIN}/api/finance/costs?sku=${encodeURIComponent(sku)}`);
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setCostMessage(data?.message || `No se pudo consultar el coste (HTTP ${response.status})`);
        return;
      }
      const results = Array.isArray(data?.results) ? data.results : [];
      setCostResults(results);
      setCostMargin(data?.margin ?? null);
      setCostMarginUpdatedAt(data?.marginUpdatedAt ?? null);
      if (!results.length) {
        setCostMessage(`Sin coste registrado para ${sku.toUpperCase()} en los snapshots de Sellerboard.`);
      }
    } catch (err) {
      setCostMessage(err instanceof Error ? err.message : "Error al consultar el coste");
    } finally {
      setSearchingCost(false);
    }
  };

  const currentMonthProfit = annual?.months.find((m) => m.period === month)?.operatingProfit ?? summary?.operatingProfit ?? 0;
  const detailedPnl = annual ? detailedRows(annual.months) : [];

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
              {detailedPnl.map((group) => (
                <Fragment key={group.key}>
                  <tr className="pnl-group">
                    <td className="font-semibold">{group.label}</td>
                    {group.amounts.map((amount, index) => <td key={index}>{money(amount)}</td>)}
                    <td className="font-semibold">{money(group.amounts.reduce((sum, amount) => sum + amount, 0))}</td>
                  </tr>
                  {group.children.map((child) => (
                    <tr className="pnl-child" key={`${group.key}-${child.key}`}>
                      <td>↳ {child.label}</td>
                      {child.amounts.map((amount, index) => <td key={index}>{money(amount)}</td>)}
                      <td>{money(child.amounts.reduce((sum, amount) => sum + amount, 0))}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-slate-500">
            La tabla incluye el desglose de movimientos Amazon disponible. COGS, IVA, sesiones y gastos indirectos requieren datos adicionales o carga manual.
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

          <section className="card mt-7">
            <div className="flex flex-wrap justify-between items-center gap-3 mb-3">
              <h2 className="title">Costes de producto (Sellerboard)</h2>
              {costMeta && (
                <span className="text-xs text-slate-400">
                  {costMeta.rowCount.toLocaleString("es-ES")} costes · {costMeta.skuCount.toLocaleString("es-ES")} SKUs · índice del{" "}
                  {new Date(costMeta.generatedAt).toLocaleString("es-ES")}
                  {costMeta.missingChunks?.length ? ` · faltan ${costMeta.missingChunks.length} chunks` : ""}
                </span>
              )}
            </div>
            <form onSubmit={searchCosts} className="grid grid-cols-1 md:grid-cols-6 gap-2">
              <input
                required
                className="field md:col-span-3"
                placeholder="SKU exacto (ej. 13159SGFBA)"
                value={costQuery}
                onChange={(e) => setCostQuery(e.target.value)}
              />
              <button disabled={searchingCost} className="button bg-emerald-600 hover:bg-emerald-500 transition-colors font-medium">
                {searchingCost ? "Buscando…" : "Buscar coste"}
              </button>
            </form>
            {costMessage && <p className="mt-2 text-xs text-cyan-300">{costMessage}</p>}
            {costMargin && (
              <div className="mt-3 p-3 rounded-lg bg-slate-800/50 border border-slate-700 text-sm">
                {costMargin.margin !== null ? (
                  <>
                    <b>Margen estimado (FBA):</b>{" "}
                    <b className={costMargin.margin > 0 ? "text-emerald-400" : "text-rose-400"}>{money(costMargin.margin)}</b>{" "}
                    ({costMargin.marginPct}% sobre precio) — precio{" "}
                    {costMargin.price !== null ? money(costMargin.price) : "?"}, tarifas{" "}
                    {costMargin.fees?.total !== null && costMargin.fees?.total !== undefined ? money(costMargin.fees.total) : "?"}, coste
                    landed {costMargin.landedCost !== null ? money(costMargin.landedCost) : "?"}
                  </>
                ) : (
                  <span className="text-slate-400">
                    Sin margen calculado para este SKU (no está en el snapshot margins:products del último sync).
                  </span>
                )}
                {costMarginUpdatedAt && (
                  <small className="block text-slate-500 mt-1">
                    Precalculado en el último sync del workflow: {new Date(costMarginUpdatedAt).toLocaleString("es-ES")}
                  </small>
                )}
              </div>
            )}
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Coste</th>
                    <th>Envío ES</th>
                    <th>IVA %</th>
                    <th>ASIN</th>
                    <th>Producto</th>
                    <th>Marketplace</th>
                    <th>Desde</th>
                    <th>Fuente</th>
                  </tr>
                </thead>
                <tbody>
                  {costResults.length > 0 ? (
                    costResults.map((c, i) => (
                      <tr key={`${c.sku}-${i}`}>
                        <td>{c.sku}</td>
                        <td className="font-semibold">{c.cost !== null ? `${c.cost.toFixed(2)} €` : "-"}</td>
                        <td>{c.domesticShippingCost !== null ? `${c.domesticShippingCost.toFixed(2)} €` : "-"}</td>
                        <td>{c.vat ?? "-"}</td>
                        <td>{c.asin || "-"}</td>
                        <td className="max-w-[320px] truncate" title={c.title}>
                          {c.title || "-"}
                        </td>
                        <td>{c.marketplace || "-"}</td>
                        <td>{c.costPeriodStartDate || "-"}</td>
                        <td className="text-slate-500">{c.sourceFile || "-"}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={9} className="text-center text-slate-500 py-4">
                        Busca un SKU para ver su coste unitario, IVA y coste de envío (importados de Sellerboard).
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
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
        .annual .pnl-group td:first-child {
          color: rgb(226 232 240);
          padding-top: 1rem;
        }
        .annual .pnl-child td:first-child {
          color: rgb(148 163 184);
          padding-left: 1.25rem;
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
