"use client";

import { API_ORIGIN } from "@/lib/apiBase";
import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { PeriodSalesDetail, type PeriodSalesDetailResult } from "@/components/sales/PeriodSalesDetail";
import { usePrivacy } from "@/lib/PrivacyContext";

const API_URL = API_ORIGIN;

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
  productRevenue?: number;
  shippingRevenue?: number;
  productTax?: number;
  shippingTax?: number;
  promotions?: number;
  customerReimbursements?: number;
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
  weekEnd?: string;
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const MONTH_NAMES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];
const MONTH_PERIOD = /^\d{4}-\d{2}$/;

/** Months of the current year up to today, most recent first, e.g. { value: "2026-09", label: "Septiembre 2026" }. */
function monthOptions(): Array<{ value: string; label: string }> {
  const now = new Date();
  const year = now.getUTCFullYear();
  const options = [];
  for (let m = now.getUTCMonth(); m >= 0; m--) {
    options.push({ value: `${year}-${String(m + 1).padStart(2, "0")}`, label: `${MONTH_NAMES[m]} ${year}` });
  }
  return options;
}

function monthRange(ym: string): { start: string; end: string } {
  const [year, month] = ym.split("-").map(Number);
  return {
    start: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    end: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)).toISOString(),
  };
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
              {row.prevYearDate
                ? `Mismo día (${shortDate(row.prevYearDate)})`
                : row.weekEnd
                ? "Misma semana 2025"
                : "Mismo mes 2025"}:
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
  const { maskProductName, maskSku } = usePrivacy();
  const [report, setReport] = useState<SalesReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState("2026");
  const [channel, setChannel] = useState(GLOBAL_CHANNEL);
  const [granularity, setGranularity] = useState<"month" | "week" | "day">("week");
  const [compareYoY, setCompareYoY] = useState(true);

  // Selected period detail state
  const [selectedPeriod, setSelectedPeriod] = useState<{
    key: string;
    label: string;
    start: string;
    end: string;
    type: "day" | "week" | "month";
  } | null>(null);

  const [periodDetail, setPeriodDetail] = useState<PeriodSalesDetailResult | null>(null);
  const [periodLoading, setPeriodLoading] = useState(false);
  const [periodError, setPeriodError] = useState<string | null>(null);

  // When changing period, adapt granularity naturally
  const handlePeriodChange = (newPeriod: string) => {
    setPeriod(newPeriod);
    setSelectedPeriod(null);
    if (newPeriod === "this_month" || MONTH_PERIOD.test(newPeriod)) {
      setGranularity("day");
    } else if (newPeriod === "2026") {
      setGranularity("month");
    }
  };

  useEffect(() => {
    setLoading(true);
    let url = `${API_URL}/api/sales/summary`;
    const isMonth = MONTH_PERIOD.test(period);
    const periodKey = isMonth || period === "this_month" || period === "last_30d" ? period : "year";
    const now = new Date();
    if (isMonth) {
      const [year, month] = period.split("-").map(Number);
      const monthStart = new Date(Date.UTC(year, month - 1, 1)).toISOString();
      const monthEnd = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)).toISOString();
      const todayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999)).toISOString();
      const effectiveEnd = monthEnd < todayEnd ? monthEnd : todayEnd;
      url += `?start=${encodeURIComponent(monthStart)}&end=${encodeURIComponent(effectiveEnd)}`;
    } else if (period === "this_month") {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
      url += `?start=${encodeURIComponent(start)}`;
    } else if (period === "last_30d") {
      const start = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      url += `?start=${encodeURIComponent(start)}`;
    } else {
      url += `?start=2026-01-01T00:00:00.000Z`;
    }
    url += `&period=${periodKey}`;

    fetch(url)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data: SalesReport) => {
        setReport(data);
        setChannel(GLOBAL_CHANNEL);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Error cargando ventas"))
      .finally(() => setLoading(false));
  }, [period]);

  // Fetch detailed breakdown whenever selectedPeriod or channel changes
  useEffect(() => {
    if (!selectedPeriod) {
      setPeriodDetail(null);
      setPeriodLoading(false);
      setPeriodError(null);
      return;
    }
    const controller = new AbortController();
    setPeriodDetail(null);
    setPeriodLoading(true);
    setPeriodError(null);

    const params = new URLSearchParams({
      start: selectedPeriod.start,
      end: selectedPeriod.end,
      channel: channel,
    });

    fetch(`${API_URL}/api/sales/details?${params.toString()}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.message || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data: PeriodSalesDetailResult) => {
        if (!controller.signal.aborted) setPeriodDetail(data);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setPeriodError(err instanceof Error ? err.message : "Error cargando desglose detallado");
      })
      .finally(() => {
        if (!controller.signal.aborted) setPeriodLoading(false);
      });
    return () => controller.abort();
  }, [selectedPeriod, channel]);

  const summary = report?.summaries[channel] ?? null;

  const chartData: ChartRow[] = useMemo(() => {
    if (!summary) return [];
    if (granularity === "month") {
      const monthMap = new Map<string, {
        revenue: number;
        prevYearRevenue: number;
        units: number;
        prevYearUnits: number;
      }>();

      for (const row of summary.byDay) {
        const ym = row.date.slice(0, 7); // e.g. "2026-03"
        const cur = monthMap.get(ym) ?? {
          revenue: 0,
          prevYearRevenue: 0,
          units: 0,
          prevYearUnits: 0,
        };
        cur.revenue += row.revenue;
        cur.prevYearRevenue += row.prevYearRevenue || 0;
        cur.units += row.units;
        cur.prevYearUnits += row.prevYearUnits || 0;
        monthMap.set(ym, cur);
      }

      return [...monthMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ym, data]) => {
        const [y, m] = ym.split("-").map(Number);
        const mIdx = m - 1;
        const monthName = MONTH_NAMES[mIdx] ?? ym;
        const revenueDiff = data.revenue - data.prevYearRevenue;
        const revenueGrowthPct = data.prevYearRevenue > 0
          ? ((data.revenue - data.prevYearRevenue) / data.prevYearRevenue) * 100
          : null;

        return {
          key: ym,
          label: `${monthName} ${y}`,
          axisLabel: monthName.slice(0, 3),
          revenue: data.revenue,
          prevYearRevenue: data.prevYearRevenue,
          units: data.units,
          prevYearUnits: data.prevYearUnits,
          revenueGrowthPct,
          revenueDiff,
        };
      });
    }
    if (granularity === "week") {
      return summary.byWeek.map((row) => ({
        key: row.weekStart,
        weekEnd: row.weekEnd,
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

  const handleSelectRow = (row: ChartRow) => {
    if (selectedPeriod?.key === row.key) {
      setSelectedPeriod(null);
      return;
    }

    if (granularity === "month") {
      const ym = row.key; // "2026-03"
      const [year, month] = ym.split("-").map(Number);
      const start = new Date(Date.UTC(year, month - 1, 1)).toISOString();
      const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)).toISOString();
      setSelectedPeriod({
        key: row.key,
        label: `Mes de ${row.label}`,
        start,
        end,
        type: "month",
      });
    } else if (granularity === "day") {
      const d = row.date || row.key;
      setSelectedPeriod({
        key: row.key,
        label: fullDisplayDate(d),
        start: d,
        end: d,
        type: "day",
      });
    } else {
      const start = row.key;
      const end = row.weekEnd || addDays(start, 6);
      setSelectedPeriod({
        key: row.key,
        label: `Semana ${row.label}`,
        start,
        end,
        type: "week",
      });
    }

    setTimeout(() => {
      const el = document.getElementById("sales-period-detail");
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }, 100);
  };

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
            <optgroup label="Por meses">
              {monthOptions().map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </optgroup>
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

          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-6">
            {[["Producto", summary.productRevenue], ["Envíos", summary.shippingRevenue], ["IVA producto", summary.productTax], ["IVA envío", summary.shippingTax], ["Promociones", summary.promotions], ["Otros", summary.customerReimbursements]].map(([label, value]) => (
              <div key={String(label)} className="rounded-lg border border-slate-800 bg-slate-900/40 p-3"><p className="text-[11px] text-slate-400">{label}</p><p className="mt-1 text-sm font-semibold text-slate-200">{currencyFull(Number(value || 0))}</p></div>
            ))}
          </div>

          {/* Trend & Chart Card */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                  Tendencia de Facturación
                </h2>
                <p className="mt-0.5 text-xs text-slate-400">
                  {granularity === "month"
                    ? "Desglose mensual comparado mes a mes con 2025."
                    : granularity === "week"
                    ? "Desglose semanal comparado semana a semana con 2025."
                    : "Desglose diario comparado con el mismo día de 2025."}
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

                {/* Month / Week / Day Switch */}
                <div className="inline-flex rounded-lg border border-slate-800 bg-slate-950 p-1 text-xs">
                  <button
                    type="button"
                    onClick={() => setGranularity("month")}
                    className={`rounded-md px-3 py-1 transition-colors font-medium ${
                      granularity === "month" ? "bg-indigo-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Mensual
                  </button>
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

            {/* Recharts Multi-Line Visualizer */}
            <div className="mt-6 h-72 sm:h-80">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chartData}
                  margin={{ top: 8, right: 8, left: 8, bottom: 0 }}
                  className="cursor-pointer"
                  onClick={(state) => {
                    if (state && state.activePayload && state.activePayload.length > 0) {
                      const row = state.activePayload[0].payload as ChartRow;
                      handleSelectRow(row);
                    }
                  }}
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
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(99,102,241,0.08)" }} />
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
                  <Line
                    type="monotone"
                    dataKey="revenue"
                    name="revenue"
                    stroke="#6366f1"
                    strokeWidth={2}
                    dot={{ r: 3, fill: "#6366f1" }}
                    activeDot={{ r: 5, cursor: "pointer" }}
                  />
                  {compareYoY && (
                    <Line
                      type="monotone"
                      dataKey="prevYearRevenue"
                      name="prevYearRevenue"
                      stroke="#94a3b8"
                      strokeWidth={2}
                      dot={{ r: 3, fill: "#94a3b8" }}
                      activeDot={{ r: 5, cursor: "pointer" }}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Interactive Selected Period Detail Dropdown/Panel */}
            {selectedPeriod && (
              <div id="sales-period-detail" className="mt-6 pt-6 border-t border-slate-800/80">
                <PeriodSalesDetail
                  title={selectedPeriod.label}
                  data={periodDetail}
                  loading={periodLoading}
                  error={periodError}
                  onClose={() => setSelectedPeriod(null)}
                />
              </div>
            )}

            {/* Scrollable Compact Breakdown Table with Sticky Header */}
            <div className="mt-8 border-t border-slate-800/80 pt-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  Tabla de Desglose {granularity === "month" ? "Mensual" : granularity === "week" ? "Semanal" : "Día a Día"} ({chartData.length} registros)
                </h3>
                <span className="text-[11px] text-slate-500">
                  Haz clic en cualquier fila o en &quot;Ver pedidos&quot; para desplegar su detalle
                </span>
              </div>
              <div className="overflow-x-auto overflow-y-auto max-h-80 rounded-lg border border-slate-800 bg-slate-950/40">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-slate-950 text-slate-400 font-semibold uppercase tracking-wider border-b border-slate-800 z-10">
                    <tr>
                      <th className="py-2.5 px-4">{granularity === "month" ? "Mes" : granularity === "week" ? "Semana" : "Fecha"}</th>
                      <th className="py-2.5 px-4 text-right">Facturación 2026</th>
                      {compareYoY && <th className="py-2.5 px-4 text-right">Facturación 2025</th>}
                      {compareYoY && <th className="py-2.5 px-4 text-right">Variación YoY</th>}
                      <th className="py-2.5 px-4 text-right">Uds 2026</th>
                      {compareYoY && <th className="py-2.5 px-4 text-right">Uds 2025</th>}
                      <th className="py-2.5 px-4 text-center">Detalle</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {[...chartData].reverse().map((row) => {
                      const growth = row.revenueGrowthPct;
                      const hasGrowth = growth !== undefined && growth !== null;
                      const isPositive = hasGrowth && growth > 0;
                      const isNegative = hasGrowth && growth < 0;
                      const isSelected = selectedPeriod?.key === row.key;

                      return (
                        <tr
                          key={row.key}
                          onClick={() => handleSelectRow(row)}
                          className={`cursor-pointer transition-colors ${
                            isSelected
                              ? "bg-indigo-950/40 border-l-4 border-indigo-500"
                              : "hover:bg-slate-800/30"
                          }`}
                        >
                          <td className="py-2 px-4 font-medium text-slate-200">
                            <div className="flex items-center gap-2">
                              {isSelected && <span className="text-indigo-400 text-xs">●</span>}
                              <span>{row.label}</span>
                            </div>
                            {granularity === "day" && row.prevYearDate && compareYoY && (
                              <div className="text-[10px] text-slate-500 pl-3.5">
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
                          <td className="py-2 px-4 text-center">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleSelectRow(row);
                              }}
                              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                                isSelected
                                  ? "bg-indigo-600 text-white shadow-sm"
                                  : "bg-slate-800/80 text-slate-300 hover:bg-slate-700 hover:text-white"
                              }`}
                            >
                              <span>{isSelected ? "Ocultar ▲" : "Ver pedidos ▼"}</span>
                            </button>
                          </td>
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
                    {summary.topProducts.map((p, idx) => {
                      const displaySku = maskSku(p.sku);
                      const displayName = maskProductName(p.name, p.sku);

                      return (
                        <tr key={p.sku} className="hover:bg-slate-800/30 transition-colors">
                          <td className="py-2.5 px-4 text-slate-300">
                            <div className="flex items-center gap-3">
                              <span className="w-5 h-5 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center text-[11px] font-bold shrink-0">
                                {idx + 1}
                              </span>
                              <div>
                                <div className="font-medium text-slate-200 line-clamp-1">{displayName}</div>
                                <div className="text-[11px] text-slate-500 font-mono">{displaySku}</div>
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
                      );
                    })}
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
