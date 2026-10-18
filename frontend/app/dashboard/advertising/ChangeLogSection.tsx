"use client";

import { useEffect, useState } from "react";
import { API_ORIGIN } from "@/lib/apiBase";

interface Entry {
  entityId: string;
  date: string;
  entityType: string;
  text: string;
  action: string;
  newValue: string | null;
  baselineMetric: string;
  reviewDate: string;
}

const ACTION: Record<string, string> = { approved: "Aprobada", rejected: "Rechazada", applied: "Aplicada", reverted: "Revertida" };

/** Change Log (spec advertising §9): every decision with its baseline and review date (+14 days). */
export function ChangeLogSection({ country }: { country: string }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);

  useEffect(() => {
    fetch(`${API_ORIGIN}/api/advertising/changelog?country=${country}`)
      .then(async (res) => setEntries(res.ok ? (((await res.json()) as { entries?: Entry[] }).entries ?? []) : []))
      .catch(() => setEntries([]));
  }, [country]);

  if (!entries) return null;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-slate-100">Registro de cambios</h2>
      <p className="text-xs text-slate-400 mt-1">Cada decisión queda registrada con su métrica de partida y su fecha de revisión. Lo aprobado hace menos de 14 días está «en maduración» y no recibe nuevas propuestas.</p>
      {entries.length === 0 ? (
        <p className="mt-2 text-xs text-slate-500">Sin decisiones registradas todavía.</p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950/80 text-slate-400 uppercase tracking-wider border-b border-slate-800">
              <tr>
                <th className="px-3 py-2.5">Fecha</th>
                <th className="px-3 py-2.5">Entidad</th>
                <th className="px-3 py-2.5">Decisión</th>
                <th className="px-3 py-2.5">Valor nuevo</th>
                <th className="px-3 py-2.5">Baseline</th>
                <th className="px-3 py-2.5">Revisión</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {entries.slice(0, 50).map((e) => (
                <tr key={`${e.entityId}-${e.date}`}>
                  <td className="px-3 py-2">{e.date.slice(0, 10)}</td>
                  <td className="px-3 py-2 text-slate-100">{e.text}<div className="text-[10px] text-slate-500">{e.entityType}</div></td>
                  <td className="px-3 py-2">{ACTION[e.action] ?? e.action}</td>
                  <td className="px-3 py-2">{e.newValue ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-400">{e.baselineMetric}</td>
                  <td className={`px-3 py-2 ${e.action === "approved" && e.reviewDate <= today ? "text-amber-300 font-semibold" : ""}`}>{e.reviewDate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
