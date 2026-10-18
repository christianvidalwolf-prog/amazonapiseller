"use client";

import { useEffect, useMemo, useState } from "react";
import { API_ORIGIN } from "@/lib/apiBase";

type Verdict = "profitable" | "leak" | "idle" | "no_cost";

interface SkuProfitability {
  sku: string;
  asin: string | null;
  spend: number;
  adSales: number;
  sameSkuUnits: number;
  acos: number | null;
  price: number | null;
  unitProfitBeforeAds: number | null;
  breakEvenAcos: number | null;
  profitAfterAds: number | null;
  verdict: Verdict;
  reason?: string;
}

interface Totals {
  spend: number;
  adSales: number;
  skus: number;
  skusWithCost: number;
  costCoverage: number;
  coverageOk: boolean;
  profitAfterAds: number;
  leakSkus: number;
  leakSpend: number;
  leakLoss: number;
}

interface ProfitabilityResponse {
  dataStatus: "ok" | "inconclusive";
  inconclusiveReason?: string;
  period?: { start: string; end: string };
  totals?: Totals;
  skus: SkuProfitability[];
  message?: string;
  error?: { kind: string; message: string };
}

const eur = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `${n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n.toFixed(1)}%`);

const VERDICT: Record<Verdict, { label: string; cls: string }> = {
  profitable: { label: "Rentable", cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" },
  leak: { label: "Fuga", cls: "bg-rose-500/10 text-rose-400 border-rose-500/30" },
  idle: { label: "Sin actividad", cls: "bg-slate-800 text-slate-500 border-slate-700" },
  no_cost: { label: "Sin coste", cls: "bg-slate-800 text-slate-400 border-slate-700" },
};

/** Proceso 1 — puente de rentabilidad: beneficio por SKU después de publicidad, en euros. */
export function ProfitabilitySection({ country }: { country: string }) {
  const [data, setData] = useState<ProfitabilityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"ALL" | Verdict>("leak");

  useEffect(() => {
    fetch(`${API_ORIGIN}/api/advertising/profitability?country=${country}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setData((await res.json()) as ProfitabilityResponse);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [country]);

  const rows = useMemo(() => (data?.skus ?? []).filter((s) => filter === "ALL" || s.verdict === filter), [data, filter]);

  if (error) return <p className="mt-8 text-xs text-rose-300">Puente de rentabilidad no disponible: {error}</p>;
  if (!data) return null;
  const t = data.totals;

  return (
    <section className="mt-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2 mb-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Puente de rentabilidad por SKU</h2>
          <p className="text-xs text-slate-400">
            Margen antes de publicidad (neto de IVA, comisiones y coste Sellerboard) frente al gasto real en Ads
            {data.period && ` · ${data.period.start} → ${data.period.end}`}. Solo cuentan las unidades del mismo SKU.
          </p>
        </div>
        {data.dataStatus !== "ok" && (
          <span className="text-xs px-2.5 py-1 rounded-full border bg-amber-500/10 text-amber-300 border-amber-500/30">
            No concluyente
          </span>
        )}
      </div>

      {(data.message || data.error) && (
        <p className="mb-4 text-xs text-amber-200/90">{data.error ? `[${data.error.kind}] ${data.error.message}` : data.message}</p>
      )}

      {t && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          <Kpi label="Gasto en Ads" value={eur(t.spend)} sub={`${t.skus} SKUs anunciados`} />
          <Kpi
            label="Cobertura de costes"
            value={`${Math.round(t.costCoverage * 100)} %`}
            sub={t.coverageOk ? "≥ 90 % del gasto: decidible" : "< 90 % del gasto: no decidir"}
            tone={t.coverageOk ? "ok" : "warn"}
          />
          <Kpi label="Beneficio tras Ads" value={eur(t.profitAfterAds)} sub={`${t.skusWithCost} SKUs con coste`} tone={t.profitAfterAds >= 0 ? "ok" : "bad"} />
          <Kpi label="Fugas" value={eur(t.leakLoss)} sub={`${t.leakSkus} SKUs · ${eur(t.leakSpend)} de gasto`} tone={t.leakSkus > 0 ? "bad" : "ok"} />
        </div>
      )}

      {data.skus.length > 0 && (
        <>
          <div className="flex gap-2 mb-2 text-xs">
            {(["leak", "profitable", "idle", "no_cost", "ALL"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 rounded-md border ${filter === f ? "bg-amber-500/15 text-amber-300 border-amber-500/40" : "bg-slate-900 text-slate-400 border-slate-700"}`}
              >
                {f === "ALL" ? "Todos" : VERDICT[f].label} ({f === "ALL" ? data.skus.length : data.skus.filter((s) => s.verdict === f).length})
              </button>
            ))}
          </div>
          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="bg-slate-950/80 text-slate-400 uppercase tracking-wider border-b border-slate-800">
                <tr>
                  <th className="px-3 py-3">SKU</th>
                  <th className="px-3 py-3 text-right">Gasto</th>
                  <th className="px-3 py-3 text-right">Ventas Ads</th>
                  <th className="px-3 py-3 text-right">ACoS</th>
                  <th className="px-3 py-3 text-right">Break-even</th>
                  <th className="px-3 py-3 text-right">Uds.</th>
                  <th className="px-3 py-3 text-right">Benef./ud.</th>
                  <th className="px-3 py-3 text-right">Tras Ads</th>
                  <th className="px-3 py-3">Veredicto</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {rows.slice(0, 200).map((s) => (
                  <tr key={s.sku} className="hover:bg-slate-800/40">
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-100">{s.sku}</div>
                      <span className="text-[10px] text-slate-500 font-mono">{s.asin}</span>
                    </td>
                    <td className="px-3 py-2 text-right text-amber-400">{eur(s.spend)}</td>
                    <td className="px-3 py-2 text-right">{eur(s.adSales)}</td>
                    <td className={`px-3 py-2 text-right ${s.acos !== null && s.breakEvenAcos !== null && s.acos > s.breakEvenAcos ? "text-rose-400" : ""}`}>{pct(s.acos)}</td>
                    <td className="px-3 py-2 text-right text-slate-400">{pct(s.breakEvenAcos)}</td>
                    <td className="px-3 py-2 text-right">{s.sameSkuUnits}</td>
                    <td className="px-3 py-2 text-right">{eur(s.unitProfitBeforeAds)}</td>
                    <td className={`px-3 py-2 text-right font-semibold ${(s.profitAfterAds ?? 0) < 0 ? "text-rose-400" : "text-emerald-400"}`}>{eur(s.profitAfterAds)}</td>
                    <td className="px-3 py-2">
                      <span title={s.reason} className={`px-2 py-0.5 rounded text-[10px] border ${VERDICT[s.verdict].cls}`}>
                        {VERDICT[s.verdict].label}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 200 && <p className="mt-2 text-[11px] text-slate-500">Mostrando 200 de {rows.length}.</p>}
        </>
      )}
    </section>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "ok" | "warn" | "bad" }) {
  const color = tone === "bad" ? "text-rose-400" : tone === "warn" ? "text-amber-300" : tone === "ok" ? "text-emerald-400" : "text-slate-100";
  return (
    <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-[11px] text-slate-500 mt-1">{sub}</div>
    </div>
  );
}
