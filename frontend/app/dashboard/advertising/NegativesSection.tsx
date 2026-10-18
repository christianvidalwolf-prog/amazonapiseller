"use client";

import { useCallback, useEffect, useState } from "react";
import { API_ORIGIN } from "@/lib/apiBase";

type Status = "proposed" | "approved" | "rejected";

interface Candidate {
  id: string;
  type: "NEGATIVE_EXACT" | "NEGATIVE_PRODUCT_TARGET";
  text: string;
  adGroupId: string;
  clicks: number;
  spend: number;
  baselineCvr: number;
  pNoSale: number;
  unitProfit: number | null;
  reason: string;
  rule?: "statistical" | "stop_loss" | "insufficient";
  maturingUntil?: string;
  status?: Status;
  decidedAt?: string;
}

interface Harvest {
  dataStatus: "ok" | "inconclusive";
  period?: { start: string; end: string };
  negatives?: {
    criteria: { alpha: number; priorClicks: number; stopLossUnits?: number };
    summary: {
      zeroSaleTerms: number;
      zeroSaleSpend: number;
      proposed: number;
      proposedSpend: number;
      insufficient: number;
      insufficientSpend: number;
      noCost: number;
      noCostSpend: number;
      accountCvr: number;
    };
    proposals: Candidate[];
    insufficient: Candidate[];
  };
  harvest?: HarvestItem[];
  message?: string;
  error?: { kind: string; message: string };
}

interface HarvestItem {
  id: string;
  type: "HARVEST_EXACT" | "HARVEST_PRODUCT_TARGET" | "NEGATIVE_EXACT_ORIGIN" | "BID_DOWN";
  rule: "harvest" | "high_acos";
  text: string;
  adGroupId: string;
  orders: number;
  clicks: number;
  spend: number;
  sales: number;
  acos: number;
  breakEvenAcos: number;
  suggestedBid: number;
  reason: string;
  status?: Status;
  maturingUntil?: string;
}

const HARVEST_LABEL: Record<HarvestItem["type"], string> = {
  HARVEST_EXACT: "Graduar a Exacta",
  HARVEST_PRODUCT_TARGET: "Graduar a producto (ASIN)",
  NEGATIVE_EXACT_ORIGIN: "Negar en origen (ACoS alto)",
  BID_DOWN: "Bajar puja (ACoS alto)",
};

const eur = (n: number) => `${n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const STATUS: Record<Status, { label: string; cls: string }> = {
  proposed: { label: "Propuesta", cls: "bg-amber-500/10 text-amber-300 border-amber-500/30" },
  approved: { label: "Aprobada", cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" },
  rejected: { label: "Rechazada", cls: "bg-slate-800 text-slate-400 border-slate-700" },
};

/** Proceso 2 — fuga por términos de búsqueda y negativas en modo propuesta (aprobación humana, no se aplica en Amazon). */
export function NegativesSection({ country }: { country: string }) {
  const [data, setData] = useState<Harvest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showInsufficient, setShowInsufficient] = useState(false);

  const load = useCallback(() => {
    fetch(`${API_ORIGIN}/api/advertising/keywords/harvest?country=${country}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setData((await res.json()) as Harvest);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [country]);

  useEffect(load, [load]);

  const decide = async (id: string, decision: Exclude<Status, "proposed">) => {
    setBusy(id);
    try {
      const res = await fetch(`${API_ORIGIN}/api/advertising/keywords/harvest?country=${country}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decision }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { message?: string }).message ?? `HTTP ${res.status}`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const buttons = (c: { id: string; status?: Status; maturingUntil?: string }) => (
    <div className="flex gap-1">
      {c.maturingUntil && <span className="text-[10px] text-slate-500 mr-1">en maduración hasta {c.maturingUntil}</span>}
      {(["approved", "rejected"] as const).map((d) => (
        <button
          key={d}
          type="button"
          disabled={busy === c.id || c.status === d}
          onClick={() => decide(c.id, d)}
          className="px-2 py-0.5 rounded border border-slate-700 text-[10px] text-slate-200 hover:bg-slate-800 disabled:opacity-40"
        >
          {d === "approved" ? "Aprobar" : "Rechazar"}
        </button>
      ))}
    </div>
  );

  if (error && !data) return <p className="mt-8 text-xs text-rose-300">Negativas no disponibles: {error}</p>;
  const n = data?.negatives;
  if (!data || !n) return data?.message ? <p className="mt-8 text-xs text-amber-200/90">{data.message}</p> : null;
  const s = n.summary;
  const dispersed = s.insufficientSpend + s.noCostSpend;

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-slate-100">Fuga por términos de búsqueda · negativas en modo propuesta</h2>
      <p className="text-xs text-slate-400 mt-1">
        Se propone negar un término sin ventas solo si, con la conversión de su grupo de anuncios, no vender en esos clics tendría
        menos de un {pct(n.criteria.alpha)} de probabilidad <b>y</b> el gasto ya supera el beneficio de una unidad; o como
        <b> stop-loss</b> si ya gastó {n.criteria.stopLossUnits ?? 1.5} × el beneficio de una unidad cuando se esperaba al menos una venta.
        Si no, es «insuficiente». Nada se aplica en Amazon sin aprobación.
        {data.period && ` Ventana ${data.period.start} → ${data.period.end}.`}
      </p>
      {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 my-4">
        <Kpi label="Gasto sin venta" value={eur(s.zeroSaleSpend)} sub={`${s.zeroSaleTerms} términos · conversión cuenta ${pct(s.accountCvr)}`} />
        <Kpi label="Recuperable (propuestas)" value={eur(s.proposedSpend)} sub={`${s.proposed} negativas con evidencia`} tone={s.proposed > 0 ? "ok" : undefined} />
        <Kpi label="Fuga dispersa" value={eur(dispersed)} sub={`${s.insufficient + s.noCost} términos sin evidencia suficiente`} tone="warn" />
        <Kpi label="Sin coste" value={eur(s.noCostSpend)} sub={`${s.noCost} términos fuera de la automatización`} />
      </div>

      {n.proposals.length === 0 ? (
        <p className="p-4 rounded-xl border border-slate-800 bg-slate-900/60 text-xs text-slate-300">
          Ningún término acumula aún evidencia suficiente para negarlo con seguridad. La fuga es dispersa (muchos términos con
          pocos clics): se ataca con pujas y pausando los SKUs en fuga del puente de rentabilidad, no con negativas.
        </p>
      ) : (
        <CandidateTable rows={n.proposals} actions={buttons} />
      )}

      <h3 className="mt-6 text-sm font-semibold text-slate-200">Cosecha y términos con ACoS alto (Proceso 3)</h3>
      <p className="text-xs text-slate-400 mt-1">
        Se gradúa un término de descubrimiento con ≥ 3 pedidos, conversión ≥ 1,5 × la media y ACoS ≤ equilibrio a Exacta (o a
        producto si es un ASIN), con negativa exacta en su grupo de origen. Con ≥ 5 pedidos y ACoS &gt; 2 × objetivo: negar en origen o
        bajar puja.
      </p>
      {(data.harvest ?? []).length === 0 ? (
        <p className="mt-2 text-xs text-slate-500">Ningún término cumple aún los criterios.</p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950/80 text-slate-400 uppercase tracking-wider border-b border-slate-800">
              <tr>
                <th className="px-3 py-2.5">Término</th>
                <th className="px-3 py-2.5">Acción</th>
                <th className="px-3 py-2.5 text-right">Pedidos</th>
                <th className="px-3 py-2.5 text-right">Ventas</th>
                <th className="px-3 py-2.5 text-right">ACoS / equilibrio</th>
                <th className="px-3 py-2.5 text-right">Puja</th>
                <th className="px-3 py-2.5">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {(data.harvest ?? []).map((h) => (
                <tr key={h.id} title={h.reason}>
                  <td className="px-3 py-2 text-slate-100">{h.text}<div className="text-[10px] text-slate-500">grupo {h.adGroupId}</div></td>
                  <td className="px-3 py-2">{HARVEST_LABEL[h.type]}</td>
                  <td className="px-3 py-2 text-right">{h.orders}</td>
                  <td className="px-3 py-2 text-right">{eur(h.sales)}</td>
                  <td className="px-3 py-2 text-right">{h.acos.toFixed(1)}% / {h.breakEvenAcos.toFixed(1)}%</td>
                  <td className="px-3 py-2 text-right">{eur(h.suggestedBid)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded text-[10px] border ${STATUS[h.status ?? "proposed"].cls}`}>{STATUS[h.status ?? "proposed"].label}</span>
                      {buttons(h)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {n.insufficient.length > 0 && (
        <div className="mt-3">
          <button type="button" onClick={() => setShowInsufficient((v) => !v)} className="text-xs text-slate-400 hover:text-slate-200">
            {showInsufficient ? "▾" : "▸"} Términos sin evidencia suficiente con más gasto ({n.insufficient.length} de {s.insufficient})
          </button>
          {showInsufficient && <CandidateTable rows={n.insufficient} />}
        </div>
      )}
    </section>
  );
}

function CandidateTable({ rows, actions }: { rows: Candidate[]; actions?: (c: Candidate) => React.ReactNode }) {
  return (
    <div className="mt-2 overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60">
      <table className="w-full text-left text-xs text-slate-300">
        <thead className="bg-slate-950/80 text-slate-400 uppercase tracking-wider border-b border-slate-800">
          <tr>
            <th className="px-3 py-2.5">Término</th>
            <th className="px-3 py-2.5 text-right">Clics</th>
            <th className="px-3 py-2.5 text-right">Gasto</th>
            <th className="px-3 py-2.5 text-right">Conv. grupo</th>
            <th className="px-3 py-2.5 text-right">P(0 ventas)</th>
            <th className="px-3 py-2.5 text-right">Benef./ud.</th>
            {actions && <th className="px-3 py-2.5">Estado</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {rows.map((c) => (
            <tr key={c.id} title={c.reason}>
              <td className="px-3 py-2">
                <div className="text-slate-100">{c.text}</div>
                <span className="text-[10px] text-slate-500">
                  {c.type === "NEGATIVE_EXACT" ? "Negativa exacta" : "Producto negativo"} · grupo {c.adGroupId}
                  {c.rule === "stop_loss" && " · stop-loss"}
                  {c.rule === "statistical" && " · evidencia estadística"}
                </span>
              </td>
              <td className="px-3 py-2 text-right">{c.clicks}</td>
              <td className="px-3 py-2 text-right text-amber-400">{eur(c.spend)}</td>
              <td className="px-3 py-2 text-right">{pct(c.baselineCvr)}</td>
              <td className="px-3 py-2 text-right">{pct(c.pNoSale)}</td>
              <td className="px-3 py-2 text-right">{c.unitProfit === null ? "—" : eur(c.unitProfit)}</td>
              {actions && (
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded text-[10px] border ${STATUS[c.status ?? "proposed"].cls}`}>{STATUS[c.status ?? "proposed"].label}</span>
                    {actions(c)}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "ok" | "warn" }) {
  const color = tone === "warn" ? "text-amber-300" : tone === "ok" ? "text-emerald-400" : "text-slate-100";
  return (
    <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-[11px] text-slate-500 mt-1">{sub}</div>
    </div>
  );
}
