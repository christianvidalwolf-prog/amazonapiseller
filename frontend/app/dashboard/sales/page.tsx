"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface DailySalesRecord {
  date: string;
  revenue: number;
  units: number;
  prevYearDate: string;
  prevYearRevenue: number;
  prevYearUnits: number;
  revenueDiff: number;
  revenueGrowthPct: number | null;
  unitsDiff: number;
  unitsGrowthPct: number | null;
}

interface WeeklySalesRecord {
  weekStart: string;
  weekEnd: string;
  revenue: number;
  units: number;
  orders: number;
  prevYearRevenue: number;
  prevYearUnits: number;
  revenueGrowthPct: number | null;
}

interface SalesSummary {
  totalRevenue: number;
  totalUnits: number;
  uniqueOrders: number;
  orderLines: number;
  prevYearTotalRevenue?: number;
  prevYearTotalUnits?: number;
  revenueGrowthYoY?: number | null;
  unitsGrowthYoY?: number | null;
  hasPreviousYearData?: boolean;
  byChannel: Array<{ channel: string; revenue: number }>;
  byFulfillment: Array<{ channel: string; units: number }>;
  byDay: DailySalesRecord[];
  byWeek: WeeklySalesRecord[];
  topProducts: Array<{ sku: string; name: string; units: number; revenue: number }>;
}

interface SalesReport {
  availableChannels: string[];
  summaries: Record<string, SalesSummary>;
}

interface ChartRow {
  key: string;
  label: string;
  axisLabel: string;
  revenue: number;
  prevYearRevenue?: number;
  units: number;
  prevYearUnits?: number;
  orders?: number;
  revenueGrowthPct?: number | null;
  revenueDiff?: number;
  date?: string;
  prevYearDate?: string;
}

const GLOBAL_CHANNEL = "ALL";

const CHANNEL_LABELS: Record<string, string> = {
  "Amazon.es": "España",
  "Amazon.de": "Alemania",
  "Amazon.fr": "Francia",
  "Amazon.it": "Italia",
  "Amazon.nl": "Países Bajos",
  "Amazon.com.be": "Bélgica",
  "Amazon.pl": "Polonia",
  "Amazon.se": "Suecia",
  "Amazon.co.uk": "Reino Unido",
  "Non-Amazon": "Fuera de Amazon",
};

const channelLabel = (channel: string) => CHANNEL_LABELS[channel] ?? channel;

const currency = (value: number) =>
  value.toLocaleString("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const currencyFull = (value: number) =>
  value.toLocaleString("es-ES", { style: "currency", currency: "EUR" });
const number = (value: number) => value.toLocaleString("es-ES");

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("es-ES", { day: "2-digit", month: "short", timeZone: "UTC" });

const fullDisplayDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

function StatCard({
  label,
  value,
  comparison,
  accent,
}: {
  label: string;
  value: string;
  comparison?: { text: string; positive?: boolean | null };
  accent: "emerald" | "blue" | "indigo" | "amber";
}) {
  const accentClass = {
    emerald: "from-emerald-500/60 to-emerald-500/0",
    blue: "from-blue-500/60 to-blue-500/0",
    indigo: "from-indigo-500/60 to-indigo-500/0",
    amber: "from-amber-500/60 to-amber-500/0",
  }[accent];

  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50 p-5 shadow-sm">
      <div className={`absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r ${accentClass}`} />
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-bold text-slate-100">{value}</p>
      {comparison && comparison.text && (
        <div className="mt-2 flex items-center gap-1.5 text-xs">
          <span
            className={`font-semibold flex items-center gap-0.5 ${
              comparison.positive === true
                ? "text-emerald-400"
                : comparison.positive === false
                ? "text-rose-400"
                : "text-slate-400"
            }`}
          >
            {comparison.positive === true ? "▲ " : comparison.positive === false ? "▼ " : ""}
            {comparison.text}
          </span>
          <span className="text-slate-500">vs año anterior</span>
        </div>
      )}
    </div>
  );
}

function SectionCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 shadow-sm">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">{title}</h2>
      {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </div>
  );
}

interface ChartTooltipPayloadEntry {
  dataKey: string;
  name: string;
  value: number;
  payload: ChartRow;
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: ChartTooltipPayloadEntry[] }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const hasPrevYear = row.prevYearRevenue !== undefined && row.prevYearRevenue > 0;

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-950/95 p-3.5 text-xs shadow-2xl backdrop-blur max-w-xs">
      <p className="font-bold text-slate-200 border-b border-slate-800 pb-1.5">{row.label}</p>
      
      {/* Current Year */}
      <div className="mt-2.5 flex items-center justify-between gap-4">
        <span className="text-indigo-400 font-medium flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-indigo-500 inline-block" />
          Año actual:
        </span>
        <span className="font-bold text-slate-100">{currencyFull(row.revenue)}</span>
      </div>
      <div className="text-[11px] text-slate-400 pl-3.5 mt-0.5">
        {number(row.units)} uds {row.orders !== undefined ? `· ${number(row.orders)} pedidos` : ""}
      </div>

      {/* Previous Year Comparison */}
      {hasPrevYear && (
        <div className="mt-2.5 pt-2 border-t border-slate-800/80">
          <div className="flex items-center justify-between gap-4">
            <span className="text-slate-400 font-medium flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-slate-500 inline-block" />
              {row.prevYearDate ? `Mismo día (${shortDate(row.prevYearDate)})` : "Misma semana 2025"}:
            </span>
            <span className="font-semibold text-slate-300">{currencyFull(row.prevYearRevenue ?? 0)}</span>
          </div>
          <div className="text-[11px] text-slate-500 pl-3.5 mt-0.5">
            {number(row.prevYearUnits ?? 0)} uds
          </div>

          {/* Growth diff */}
          {row.revenueGrowthPct !== undefined && row.revenueGrowthPct !== null && (
            <div className="mt-2 flex items-center justify-between text-xs font-semibold px-2 py-1 rounded bg-slate-900 border border-slate-800">
              <span className="text-slate-400">Variación YoY:</span>
              <span
                className={
                  row.revenueGrowthPct > 0
                    ? "text-emerald-400"
                    : row.revenueGrowthPct < 0
                    ? "text-rose-400"
                    : "text-slate-400"
                }
              >
                {row.revenueGrowthPct > 0 ? "+" : ""}
                {row.revenueGrowthPct.toFixed(1)}% (
                {row.revenueDiff && row.revenueDiff > 0 ? "+" : ""}
                {currencyFull(row.revenueDiff ?? 0)})
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SalesPage() {
  const [report, setReport] = useState<SalesReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState("2026");
  const [channel, setChannel] = useState(GLOBAL_CHANNEL);
  const [granularity, setGranularity] = useState<"week" | "day">("week");
  const [compareYoY, setCompareYoY] = useState(true);

  // When changing period, adapt granularity naturally
  const handlePeriodChange = (newPeriod: string) => {
    setPeriod(newPeriod);
    if (newPeriod === "this_month") {
      setGranularity("day");
    } else if (newPeriod === "2026") {
      setGranularity("week");
    }
  };

  useEffect(() => {
    setLoading(true);
    let url = `${API_URL}/api/sales/summary`;
    if (period === "this_month") {
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
      url += `?start=${encodeURIComponent(start)}`;
    } else if (period === "last_30d") {
      const start = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      url += `?start=${encodeURIComponent(start)}`;
    } else {
      url += `?start=2026-01-01T00:00:00.000Z`;
    }

    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: SalesReport) => {
        setReport(data);
        setChannel(GLOBAL_CHANNEL);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Error cargando ventas"))
      .finally(() => setLoading(false));
  }, [period]);

  const summary = report?.summaries[channel] ?? null;

  const chartData: ChartRow[] = useMemo(() => {
    if (!summary) return [];
    if (granularity === "week") {
      return summary.byWeek.map((row) => ({
        key: row.weekStart,
        label: `${shortDate(row.weekStart)} – ${shortDate(row.weekEnd)}`,
        axisLabel: shortDate(row.weekStart),
        revenue: row.revenue,
        prevYearRevenue: row.prevYearRevenue,
        units: row.units,
        prevYearUnits: row.prevYearUnits,
        orders: row.orders,
        revenueGrowthPct: row.revenueGrowthPct,
        revenueDiff: row.revenue - row.prevYearRevenue,
      }));
    }
    return summary.byDay.map((row) => ({
      key: row.date,
      date: row.date,
      prevYearDate: row.prevYearDate,
      label: fullDisplayDate(row.date),
      axisLabel: shortDate(row.date),
      revenue: row.revenue,
      prevYearRevenue: row.prevYearRevenue,
      units: row.units,
      prevYearUnits: row.prevYearUnits,
      revenueGrowthPct: row.revenueGrowthPct,
      revenueDiff: row.revenueDiff,
    }));
  }, [summary, granularity]);

  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pb-6 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
              <span className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-lg">
                📈
              </span>
              Ventas y Rendimiento
            </h1>
            <span className="text-xs px-2.5 py-1 rounded-full font-medium border bg-indigo-500/10 text-indigo-400 border-indigo-500/30 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
              Comparativa YoY
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            {channel === GLOBAL_CHANNEL
              ? "Métricas consolidadas de facturación comparadas con el año anterior (2025)."
              : `Métricas de facturación para ${channelLabel(channel)} comparadas con 2025.`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-400">País:</span>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            disabled={!report}
            className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
          >
            <option value={GLOBAL_CHANNEL}>Global (todos los países)</option>
            {report?.availableChannels.map((ch) => (
              <option key={ch} value={ch}>
                {channelLabel(ch)}
              </option>
            ))}
          </select>

          <span className="ml-2 text-xs text-slate-400">Periodo:</span>
          <select
            value={period}
            onChange={(e) => handlePeriodChange(e.target.value)}
            className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
          >
            <option value="2026">Todo el año 2026</option>
            <option value="this_month">Mes actual (Septiembre)</option>
            <option value="last_30d">Últimos 30 días</option>
          </select>
        </div>
      </div>

      {loading && (
        <div className="mt-10 flex items-center gap-3 text-slate-400 py-12 justify-center">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-indigo-400" />
          <span>Cargando métricas de ventas y comparativa interanual...</span>
        </div>
      )}

      {error && (
        <div className="p-4 rounded-lg bg-red-950/40 border border-red-800 text-red-300 text-sm">
          Error: {error}
        </div>
      )}

      {summary && !loading && (
        <>
          {/* Main KPI StatCards Grid */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label="Facturación total"
              value={currencyFull(summary.totalRevenue)}
              comparison={
                summary.revenueGrowthYoY !== undefined && summary.revenueGrowthYoY !== null
                  ? {
                      text: `${summary.revenueGrowthYoY > 0 ? "+" : ""}${summary.revenueGrowthYoY}%`,
                      positive: summary.revenueGrowthYoY >= 0,
                    }
                  : undefined
              }
              accent="emerald"
            />
            <StatCard
              label="Unidades vendidas"
              value={number(summary.totalUnits)}
              comparison={
                summary.unitsGrowthYoY !== undefined && summary.unitsGrowthYoY !== null
                  ? {
                      text: `${summary.unitsGrowthYoY > 0 ? "+" : ""}${summary.unitsGrowthYoY}%`,
                      positive: summary.unitsGrowthYoY >= 0,
                    }
                  : undefined
              }
              accent="blue"
            />
            <StatCard
              label="Facturación Año Anterior"
              value={currencyFull(summary.prevYearTotalRevenue ?? 0)}
              comparison={{
                text: `${number(summary.prevYearTotalUnits ?? 0)} uds`,
                positive: null,
              }}
              accent="indigo"
            />
            <StatCard
              label="Ticket medio"
              value={summary.uniqueOrders ? currencyFull(summary.totalRevenue / summary.uniqueOrders) : "-"}
              accent="amber"
            />
          </div>

          {/* Trend & Chart Card */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                  Tendencia de Facturación
                </h2>
                <p className="mt-0.5 text-xs text-slate-400">
                  {granularity === "day"
                    ? "Desglose diario comparado con el mismo día de 2025."
                    : "Desglose semanal comparado semana a semana con 2025."}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {/* YoY Toggle */}
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800 hover:border-slate-700 transition-colors">
                  <input
                    type="checkbox"
                    checked={compareYoY}
                    onChange={(e) => setCompareYoY(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-0 cursor-pointer"
                  />
                  <span>Comparar 2025</span>
                </label>

                {/* Day / Week Switch */}
                <div className="inline-flex rounded-lg border border-slate-800 bg-slate-950 p-1 text-xs">
                  <button
                    type="button"
                    onClick={() => setGranularity("week")}
                    className={`rounded-md px-3 py-1 transition-colors font-medium ${
                      granularity === "week" ? "bg-indigo-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Semanal
                  </button>
                  <button
                    type="button"
                    onClick={() => setGranularity("day")}
                    className={`rounded-md px-3 py-1 transition-colors font-medium ${
                      granularity === "day" ? "bg-indigo-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Diario
                  </button>
                </div>
              </div>
            </div>

            {/* Recharts Multi-Bar Visualizer */}
            <div className="mt-6 h-72 sm:h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{ top: 8, right: 8, left: 8, bottom: 0 }}
                  barGap={granularity === "day" ? 1 : 4}
                >
                  <CartesianGrid vertical={false} stroke="#1e293b" />
                  <XAxis
                    dataKey="axisLabel"
                    tick={{ fill: "#64748b", fontSize: 11 }}
                    axisLine={{ stroke: "#1e293b" }}
                    tickLine={false}
                    interval={granularity === "day" ? Math.max(0, Math.ceil(chartData.length / 15) - 1) : 0}
                  />
                  <YAxis
                    tick={{ fill: "#64748b", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(value: number) => currency(value)}
                    width={64}
                  />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(99,102,241,0.06)" }} />
                  {compareYoY && (
                    <Legend
                      verticalAlign="top"
                      align="right"
                      wrapperStyle={{ paddingBottom: 12, fontSize: 11 }}
                      formatter={(value) => (
                        <span className="text-xs text-slate-300">
                          {value === "revenue" ? "2026 (Actual)" : "2025 (Mismo periodo)"}
                        </span>
                      )}
                    />
                  )}
                  <Bar
                    dataKey="revenue"
                    name="revenue"
                    fill="#6366f1"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={granularity === "week" ? 36 : 14}
                  />
                  {compareYoY && (
                    <Bar
                      dataKey="prevYearRevenue"
                      name="prevYearRevenue"
                      fill="#94a3b8"
                      radius={[4, 4, 0, 0]}
                      maxBarSize={granularity === "week" ? 36 : 14}
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Scrollable Compact Breakdown Table with Sticky Header */}
            <div className="mt-8 border-t border-slate-800/80 pt-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  Tabla de Desglose {granularity === "day" ? "Día a Día" : "Semanal"} ({chartData.length} registros)
                </h3>
                {granularity === "day" && chartData.length > 30 && (
                  <span className="text-[11px] text-slate-500">Mostrando historial completo desplazable</span>
                )}
              </div>
              <div className="overflow-x-auto overflow-y-auto max-h-72 rounded-lg border border-slate-800 bg-slate-950/40">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-slate-950 text-slate-400 font-semibold uppercase tracking-wider border-b border-slate-800 z-10">
                    <tr>
                      <th className="py-2.5 px-4">{granularity === "week" ? "Semana" : "Fecha"}</th>
                      <th className="py-2.5 px-4 text-right">Facturación 2026</th>
                      {compareYoY && <th className="py-2.5 px-4 text-right">Facturación 2025</th>}
                      {compareYoY && <th className="py-2.5 px-4 text-right">Variación YoY</th>}
                      <th className="py-2.5 px-4 text-right">Uds 2026</th>
                      {compareYoY && <th className="py-2.5 px-4 text-right">Uds 2025</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {[...chartData].reverse().map((row) => {
                      const growth = row.revenueGrowthPct;
                      const hasGrowth = growth !== undefined && growth !== null;
                      const isPositive = hasGrowth && growth > 0;
                      const isNegative = hasGrowth && growth < 0;

                      return (
                        <tr key={row.key} className="hover:bg-slate-800/30 transition-colors">
                          <td className="py-2 px-4 font-medium text-slate-200">
                            <div>{row.label}</div>
                            {granularity === "day" && row.prevYearDate && compareYoY && (
                              <div className="text-[10px] text-slate-500">
                                vs {shortDate(row.prevYearDate)} 2025
                              </div>
                            )}
                          </td>
                          <td className="py-2 px-4 text-right font-semibold text-indigo-400">
                            {currencyFull(row.revenue)}
                          </td>
                          {compareYoY && (
                            <td className="py-2 px-4 text-right font-medium text-slate-400">
                              {currencyFull(row.prevYearRevenue ?? 0)}
                            </td>
                          )}
                          {compareYoY && (
                            <td className="py-2 px-4 text-right">
                              {hasGrowth ? (
                                <span
                                  className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-semibold text-[11px] ${
                                    isPositive
                                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                                      : isNegative
                                      ? "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                                      : "bg-slate-800 text-slate-400"
                                  }`}
                                >
                                  {isPositive ? "▲ +" : isNegative ? "▼ " : ""}
                                  {growth.toFixed(1)}%
                                </span>
                              ) : (
                                <span className="text-slate-500 text-[11px]">-</span>
                              )}
                            </td>
                          )}
                          <td className="py-2 px-4 text-right text-slate-300 font-medium">
                            {number(row.units)}
                          </td>
                          {compareYoY && (
                            <td className="py-2 px-4 text-right text-slate-500">
                              {number(row.prevYearUnits ?? 0)}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Channels & Logistics Grid */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <SectionCard title="Ventas por marketplace / canal">
              <ul className="divide-y divide-slate-800/80">
                {summary.byChannel.map((row) => (
                  <li key={row.channel} className="flex justify-between py-2.5 text-sm">
                    <span className="font-medium text-slate-300">{row.channel}</span>
                    <span className="font-semibold text-emerald-400">{currencyFull(row.revenue)}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>

            <SectionCard title="Logística (FBA vs FBM)">
              <ul className="divide-y divide-slate-800/80">
                {summary.byFulfillment.map((row) => (
                  <li key={row.channel} className="flex justify-between py-2.5 text-sm">
                    <span className="font-medium text-slate-300">
                      {row.channel.toLowerCase().includes("amazon") || row.channel.toLowerCase().includes("afn")
                        ? "FBA (Gestionado por Amazon)"
                        : "FBM (Gestionado por Vendedor)"}
                    </span>
                    <span className="font-semibold text-blue-400">{number(row.units)} uds</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          </div>

          {/* Top 10 Productos Más Vendidos Section */}
          {summary.topProducts && summary.topProducts.length > 0 && (
            <SectionCard title="Top 10 productos más vendidos" subtitle="Por facturación en el periodo seleccionado">
              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table className="w-full text-left text-xs sm:text-sm">
                  <thead className="border-b border-slate-800 bg-slate-950/80 text-slate-400 uppercase font-semibold">
                    <tr>
                      <th className="py-2.5 px-4 font-medium">Producto / SKU</th>
                      <th className="py-2.5 px-4 font-medium text-right">Unidades</th>
                      <th className="py-2.5 px-4 font-medium text-right">Facturación</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {summary.topProducts.map((p, idx) => (
                      <tr key={p.sku} className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-2.5 px-4 text-slate-300">
                          <div className="flex items-center gap-3">
                            <span className="w-5 h-5 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center text-[11px] font-bold shrink-0">
                              {idx + 1}
                            </span>
                            <div>
                              <div className="font-medium text-slate-200 line-clamp-1">{p.name || p.sku}</div>
                              <div className="text-[11px] text-slate-500 font-mono">{p.sku}</div>
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 px-4 text-right text-slate-300 font-medium">
                          {number(p.units)} uds
                        </td>
                        <td className="py-2.5 px-4 text-right font-semibold text-emerald-400">
                          {currencyFull(p.revenue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}
        </>
      )}
    </main>
  );
}
