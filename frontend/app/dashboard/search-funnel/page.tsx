"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_ORIGIN } from "@/lib/apiBase";
import {
  buildDiagnosis,
  filterFunnel,
  type FunnelStatus,
  type ReportPeriod,
  type SearchFunnelResponse,
  type SearchFunnelRow,
  type SearchFunnelSyncStatus,
  STATUS_META,
} from "@/lib/searchFunnel";

const ENDPOINT = `${API_ORIGIN}/api/brand-analytics/search-funnel`;
const PAGE_SIZE = 100;
const SYNC_POLL_MS = 5000;

const int = (value: number): string => new Intl.NumberFormat("es-ES").format(Math.round(value));
const pct = (value: number, decimals = 1): string => `${(value * 100).toFixed(decimals)}%`;
const day = (iso: string | null): string => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("es-ES", { timeZone: "UTC" }) : "—");

const STATUS_FILTERS: Array<{ value: FunnelStatus | ""; label: string }> = [
  { value: "", label: "Todos los estados" },
  { value: "DROP_IMPRESSIONS_TO_CLICKS", label: "Fuga en SERP" },
  { value: "DROP_CLICKS_TO_CART", label: "Fuga en ficha" },
  { value: "DROP_CART_TO_PURCHASE", label: "Fuga en cierre" },
  { value: "WINNER", label: "Ganadores" },
];

const SELECT = "bg-slate-900 border border-slate-800 text-slate-300 rounded-lg px-3 py-1.5 text-xs focus:ring-1 focus:ring-emerald-400";

export default function SearchFunnelPage() {
  const [period, setPeriod] = useState<ReportPeriod>("WEEK");
  const [asin, setAsin] = useState("");
  const [status, setStatus] = useState<FunnelStatus | "">("");
  const [search, setSearch] = useState("");
  const [data, setData] = useState<SearchFunnelResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<SearchFunnelSyncStatus | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diagnosed, setDiagnosed] = useState<SearchFunnelRow | null>(null);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One request per period; ASIN, status and text filters are applied to it in the browser.
  const load = useCallback(async (target: ReportPeriod) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${ENDPOINT}?period=${target}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message || `Error ${res.status}`);
      setData(body as SearchFunnelResponse);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : "No se pudo cargar el informe");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(period);
  }, [load, period]);

  useEffect(() => () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
  }, []);

  const pollSync = useCallback(async () => {
    try {
      const res = await fetch(`${ENDPOINT}/sync`, { cache: "no-store" });
      const body = (await res.json()) as SearchFunnelSyncStatus;
      setSync(body);
      if (body.state === "running") {
        pollTimer.current = setTimeout(() => void pollSync(), SYNC_POLL_MS);
        return;
      }
      if (body.state === "failed") setSyncNote(`Amazon rechazó el informe: ${body.errors[0] ?? "sin detalle"}`);
      else if (body.errors.length) setSyncNote(`Sincronizado con ${body.errors.length} lote(s) de ASIN rechazados por Amazon.`);
      if (body.period) void load(body.period);
    } catch {
      setSync(null);
      setSyncNote("Se perdió la conexión con el backend durante la sincronización.");
    }
  }, [load]);

  const startSync = async () => {
    setSyncNote(null);
    try {
      const res = await fetch(`${ENDPOINT}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, ...(asin ? { asin } : {}) }),
      });
      const body = await res.json();
      if (!res.ok) {
        setSyncNote(body?.message || `Error ${res.status}`);
        return;
      }
      setSync(body as SearchFunnelSyncStatus);
      pollTimer.current = setTimeout(() => void pollSync(), SYNC_POLL_MS);
    } catch {
      setSyncNote("No se pudo contactar con el backend.");
    }
  };

  const filtered = useMemo(() => (data ? filterFunnel(data, { asin: asin || undefined }) : null), [data, asin]);
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (filtered?.rows ?? []).filter(
      (row) => (!status || row.status === status) && (!needle || row.queryText.toLowerCase().includes(needle))
    );
  }, [filtered, status, search]);

  useEffect(() => {
    setVisible(PAGE_SIZE);
    setExpanded(null);
  }, [period, asin, status, search]);

  const summary = filtered?.summary;
  const syncing = sync?.state === "running";
  const showAsinColumn = !asin;
  const columns = showAsinColumn ? 9 : 8;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-100">Funnels de Búsqueda</h1>
          <p className="text-sm text-slate-400 mt-1">
            Brand Analytics · Search Query Performance. Dónde pierde cada término al cliente entre impresión, clic, cesta y compra.
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Período {day(data?.periodStart ?? null)} – {day(data?.periodEnd ?? null)}
            {data?.updatedAt ? ` · actualizado ${new Date(data.updatedAt).toLocaleString("es-ES")}` : ""}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="ASIN" value={asin} onChange={(e) => setAsin(e.target.value)} className={`${SELECT} max-w-[16rem]`}>
            <option value="">Catálogo completo ({data?.asins.length ?? 0} ASIN)</option>
            {data?.asins.map((item) => (
              <option key={item.asin} value={item.asin}>
                {item.asin}
                {item.name ? ` · ${item.name.slice(0, 50)}` : ""}
              </option>
            ))}
          </select>
          <div className="flex rounded-lg border border-slate-800 overflow-hidden text-xs">
            {(["WEEK", "MONTH"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setPeriod(value)}
                className={`px-3 py-1.5 transition ${period === value ? "bg-amber-400/15 text-amber-300 font-semibold" : "bg-slate-900 text-slate-400 hover:text-slate-200"}`}
              >
                {value === "WEEK" ? "Última semana" : "Último mes"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void startSync()}
            disabled={syncing}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40 hover:bg-emerald-500/25 disabled:opacity-60 disabled:cursor-wait transition flex items-center gap-2"
          >
            {syncing && <span className="w-3 h-3 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />}
            {syncing ? "Pidiendo informe a Amazon…" : "Sincronizar"}
          </button>
        </div>
      </div>

      {syncing && (
        <div className="p-3 rounded-xl bg-emerald-950/30 border border-emerald-800/40 text-emerald-200 text-xs">
          Amazon está generando el informe de {sync?.requestedAsins} ASIN. Suele tardar unos minutos; la tabla se recarga sola al terminar.
        </div>
      )}
      {syncNote && <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-800/40 text-amber-200 text-xs">{syncNote}</div>}
      {error && (
        <div className="p-4 rounded-xl bg-red-950/40 border border-red-800/50 text-red-300 text-sm flex items-center justify-between gap-4">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void load(period)}
            className="px-3 py-1 bg-red-900/60 hover:bg-red-800/80 text-red-200 text-xs rounded-md transition shrink-0"
          >
            Reintentar
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Kpi label="Consultas analizadas" value={summary?.totalQueries} tone="text-slate-100" />
        <Kpi
          label="Fuga en SERP"
          value={summary?.dropImpressionsToClicks}
          detail={summary ? `${int(summary.lostClicks)} clics perdidos` : undefined}
          tone="text-red-300"
          onClick={() => setStatus("DROP_IMPRESSIONS_TO_CLICKS")}
        />
        <Kpi
          label="Fuga en ficha"
          value={summary?.dropClicksToCart}
          detail={summary ? `${int(summary.lostCartAdds)} cestas perdidas` : undefined}
          tone="text-orange-300"
          onClick={() => setStatus("DROP_CLICKS_TO_CART")}
        />
        <Kpi
          label="Fuga en cierre"
          value={summary?.dropCartToPurchase}
          detail={summary ? `${int(summary.lostPurchases)} compras perdidas` : undefined}
          tone="text-amber-300"
          onClick={() => setStatus("DROP_CART_TO_PURCHASE")}
        />
        <Kpi
          label="Ganadores a proteger"
          value={summary?.winners}
          tone="text-emerald-300"
          onClick={() => setStatus("WINNER")}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Estado del funnel" value={status} onChange={(e) => setStatus(e.target.value as FunnelStatus | "")} className={SELECT}>
            {STATUS_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar término…"
            className={`${SELECT} w-48 sm:w-64`}
          />
        </div>
        <span className="text-xs text-slate-500">{int(rows.length)} términos · ordenados por impacto</span>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden shadow-xl">
        {loading ? (
          <div className="p-12 text-center text-slate-400 text-sm flex flex-col items-center justify-center gap-3">
            <div className="w-8 h-8 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
            Cargando términos de búsqueda…
          </div>
        ) : rows.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-sm">
            {data && data.rows.length === 0 && !error
              ? "Todavía no hay informe para este período. Pulsa «Sincronizar» para pedirlo a Amazon."
              : "Ningún término coincide con los filtros."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-950/60 text-slate-400 text-left">
                <tr>
                  <th className="px-3 py-2.5 font-medium">Query</th>
                  {showAsinColumn && <th className="px-3 py-2.5 font-medium">ASIN</th>}
                  <th className="px-3 py-2.5 font-medium text-right">Volumen total</th>
                  <th className="px-3 py-2.5 font-medium text-right">Impresiones (share)</th>
                  <th className="px-3 py-2.5 font-medium text-right">Clics (CTR)</th>
                  <th className="px-3 py-2.5 font-medium text-right">Cestas (cart rate)</th>
                  <th className="px-3 py-2.5 font-medium text-right">Compras (purchase rate)</th>
                  <th className="px-3 py-2.5 font-medium">Estado</th>
                  <th className="px-3 py-2.5 font-medium">Acción sugerida</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {rows.slice(0, visible).map((row) => {
                  const key = `${row.asin}|${row.queryText}`;
                  const meta = STATUS_META[row.status];
                  const open = expanded === key;
                  const hasDiagnosis = row.status !== "NORMAL" && row.status !== "LOW_VOLUME";
                  return (
                    <Fragment key={key}>
                      <tr className={`hover:bg-slate-800/40 transition ${open ? "bg-slate-800/30" : ""}`}>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            aria-expanded={open}
                            onClick={() => setExpanded(open ? null : key)}
                            className="flex items-center gap-2 text-left text-slate-100 font-medium hover:text-amber-300"
                          >
                            <span className={`text-slate-500 transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
                            {row.queryText}
                          </button>
                        </td>
                        {showAsinColumn && <td className="px-3 py-2 font-mono text-slate-400">{row.asin}</td>}
                        <td className="px-3 py-2 text-right tabular-nums text-slate-200">{int(row.totalQueryVolume)}</td>
                        <Metric count={row.asinImpressions} rate={pct(row.asinImpressionShare)} />
                        <Metric count={row.asinClicks} rate={pct(row.ctr, 2)} />
                        <Metric count={row.asinCartAdds} rate={pct(row.cartRate)} />
                        <Metric count={row.asinPurchases} rate={pct(row.purchaseRate)} />
                        <td className="px-3 py-2">
                          <span className={`inline-block px-2 py-0.5 rounded-full ring-1 whitespace-nowrap ${meta.badge}`}>{meta.label}</span>
                        </td>
                        <td className="px-3 py-2 text-slate-400">
                          {hasDiagnosis ? (
                            <div className="flex flex-col items-start gap-1">
                              <span>{meta.action}</span>
                              <button type="button" onClick={() => setDiagnosed(row)} className="text-amber-300 hover:text-amber-200 underline underline-offset-2">
                                Ver diagnóstico
                              </button>
                            </div>
                          ) : (
                            meta.action
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr className="bg-slate-950/50">
                          <td colSpan={columns} className="px-4 py-4">
                            <FunnelComparison row={row} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > visible && (
          <div className="p-3 text-center border-t border-slate-800">
            <button type="button" onClick={() => setVisible((n) => n + PAGE_SIZE)} className="text-xs text-amber-300 hover:text-amber-200">
              Mostrar {Math.min(PAGE_SIZE, rows.length - visible)} más ({int(rows.length - visible)} restantes)
            </button>
          </div>
        )}
      </div>

      {diagnosed && <DiagnosisDrawer row={diagnosed} onClose={() => setDiagnosed(null)} />}
    </div>
  );
}

function Kpi(props: { label: string; value: number | undefined; detail?: string; tone: string; onClick?: () => void }) {
  const content = (
    <>
      <div className="text-xs text-slate-400 font-medium uppercase tracking-wide">{props.label}</div>
      <div className={`mt-2 text-2xl font-bold tabular-nums ${props.tone}`}>{props.value == null ? "—" : int(props.value)}</div>
      <div className="mt-1 text-xs text-slate-500 min-h-[1rem]">{props.detail}</div>
    </>
  );
  const box = "p-4 rounded-2xl bg-gradient-to-br from-slate-900 to-slate-950 border border-slate-800 text-left";
  return props.onClick ? (
    <button type="button" onClick={props.onClick} className={`${box} hover:border-amber-400/50 transition`}>
      {content}
    </button>
  ) : (
    <div className={box}>{content}</div>
  );
}

function Metric({ count, rate }: { count: number; rate: string }) {
  return (
    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
      <span className="text-slate-200">{int(count)}</span> <span className="text-slate-500">({rate})</span>
    </td>
  );
}

/**
 * Two funnels side by side. Bar length is the stage count relative to
 * impressions on a square-root scale: on a linear one every stage after
 * impressions would be a sliver, since clicks are ~1% of impressions.
 */
function FunnelComparison({ row }: { row: SearchFunnelRow }) {
  const stages = [
    { label: "Impresiones", asin: row.asinImpressions, market: row.totalImpressions, share: row.asinImpressionShare },
    { label: "Clics", asin: row.asinClicks, market: row.totalClicks, share: row.asinClickShare },
    { label: "Cestas", asin: row.asinCartAdds, market: row.totalCartAdds, share: row.asinCartAddShare },
    { label: "Compras", asin: row.asinPurchases, market: row.totalPurchases, share: row.asinPurchaseShare },
  ];
  const width = (count: number, top: number): string => `${top > 0 ? Math.max(1.5, Math.sqrt(count / top) * 100) : 0}%`;
  const stepRate = (count: number, previous: number | undefined): string =>
    previous === undefined ? "" : previous > 0 ? ` · ${pct(count / previous, 1)} del paso anterior` : "";

  const series = [
    { title: `Tu ASIN ${row.asin}`, bar: "bg-amber-400", values: stages.map((s) => s.asin) },
    { title: "Total del mercado para el término", bar: "bg-sky-400", values: stages.map((s) => s.market) },
  ];

  return (
    <div className="space-y-3">
      <div className="grid md:grid-cols-2 gap-6">
        {series.map((item) => (
          <div key={item.title}>
            <div className="text-xs font-semibold text-slate-300 mb-2">{item.title}</div>
            <div className="space-y-1.5">
              {stages.map((stage, index) => (
                <div key={stage.label}>
                  <div className="flex justify-between text-[11px] text-slate-400">
                    <span>{stage.label}</span>
                    <span className="tabular-nums">
                      <span className="text-slate-200">{int(item.values[index])}</span>
                      {stepRate(item.values[index], item.values[index - 1])}
                    </span>
                  </div>
                  <div className="h-2.5 rounded bg-slate-800/80">
                    <div className={`h-full rounded ${item.bar}`} style={{ width: width(item.values[index], item.values[0]) }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-slate-400 border-t border-slate-800 pt-2">
        <span className="text-slate-500">Cuota del ASIN en cada etapa:</span>
        {stages.map((stage) => (
          <span key={stage.label}>
            {stage.label} <span className="text-slate-200 tabular-nums">{pct(stage.share)}</span>
          </span>
        ))}
        <span className="text-slate-600">Barras en escala de raíz cuadrada.</span>
      </div>
    </div>
  );
}

function DiagnosisDrawer({ row, onClose }: { row: SearchFunnelRow; onClose: () => void }) {
  const diagnosis = buildDiagnosis(row);
  const meta = STATUS_META[row.status];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!diagnosis) return null;
  return (
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label="Diagnóstico del término">
      <button type="button" aria-label="Cerrar" onClick={onClose} className="absolute inset-0 bg-slate-950/70" />
      <aside className="relative w-full max-w-md h-full overflow-y-auto bg-slate-900 border-l border-slate-800 p-6 space-y-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className={`inline-block px-2 py-0.5 rounded-full ring-1 text-xs ${meta.badge}`}>{meta.label}</span>
            <h2 className="mt-2 text-lg font-bold text-slate-100">{row.queryText}</h2>
            <p className="text-xs text-slate-500 font-mono">
              {row.asin} · {int(row.totalQueryVolume)} búsquedas
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-100 text-xl leading-none">
            ×
          </button>
        </div>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Dónde se corta el flujo</h3>
          <p className="mt-1.5 text-sm text-slate-200">{diagnosis.breakpoint}</p>
          <p className="mt-2 text-sm text-slate-400">{diagnosis.cause}</p>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">3 tareas recomendadas</h3>
          <ol className="mt-2 space-y-2">
            {diagnosis.tasks.map((task, index) => (
              <li key={task} className="flex gap-3 p-3 rounded-xl bg-slate-950/60 border border-slate-800 text-sm text-slate-200">
                <span className="shrink-0 w-5 h-5 rounded-full bg-amber-400/15 text-amber-300 text-xs font-bold flex items-center justify-center">
                  {index + 1}
                </span>
                {task}
              </li>
            ))}
          </ol>
        </section>

        <section className="border-t border-slate-800 pt-4">
          <FunnelComparison row={row} />
        </section>

        <p className="text-[11px] text-slate-600">Diagnóstico generado por reglas a partir de las métricas del término.</p>
      </aside>
    </div>
  );
}
