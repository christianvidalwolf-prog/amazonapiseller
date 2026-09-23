"use client";

import { API_ORIGIN } from "@/lib/apiBase";
import { useEffect, useState } from "react";
import Link from "next/link";

const API_URL = API_ORIGIN;

interface InventoryRow {
  sku: string;
  asin: string;
  name?: string;
  total?: number;
  fulfillable: number;
  reserved: number;
  inbound: number;
}

export default function InventoryPage() {
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [onlyWithStock, setOnlyWithStock] = useState(true);

  useEffect(() => {
    fetch(`${API_URL}/api/inventory/snapshot`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => setRows(data.rows || []))
      .catch((err) => setError(err instanceof Error ? err.message : "Error cargando inventario"))
      .finally(() => setLoading(false));
  }, []);

  const filtered = rows.filter((row) => {
    if (onlyWithStock && !(row.fulfillable > 0 || row.reserved > 0 || row.inbound > 0)) {
      return false;
    }
    if (!search) return true;
    const term = search.toLowerCase();
    return (
      row.sku.toLowerCase().includes(term) ||
      row.asin.toLowerCase().includes(term) ||
      (row.name && row.name.toLowerCase().includes(term))
    );
  });

  const totalDisponibles = rows.reduce((acc, r) => acc + r.fulfillable, 0);
  const totalReservados = rows.reduce((acc, r) => acc + r.reserved, 0);
  const totalEntrantes = rows.reduce((acc, r) => acc + r.inbound, 0);

  return (
    <main className="p-10 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Inventario y Logística (FBA)</h1>
          <p className="mt-1 text-sm text-slate-400">Datos en vivo sincronizados con Amazon SP-API.</p>
        </div>
        <Link
          href="/listings"
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-all shadow-sm"
        >
          <span>📄</span> Subir Precios / Stock CSV
        </Link>
      </div>

      {loading && <p className="mt-6 text-slate-400">Cargando inventario…</p>}
      {error && <p className="mt-6 text-red-400">Error: {error}</p>}

      {!loading && !error && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
              <p className="text-sm text-slate-400">Total SKUs FBA</p>
              <p className="mt-1 text-2xl font-semibold text-slate-100">{rows.length.toLocaleString("es-ES")}</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
              <p className="text-sm text-slate-400">Unidades Disponibles</p>
              <p className="mt-1 text-2xl font-semibold text-emerald-400">{totalDisponibles.toLocaleString("es-ES")}</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
              <p className="text-sm text-slate-400">Unidades Reservadas</p>
              <p className="mt-1 text-2xl font-semibold text-amber-400">{totalReservados.toLocaleString("es-ES")}</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
              <p className="text-sm text-slate-400">En Camino (Inbound)</p>
              <p className="mt-1 text-2xl font-semibold text-blue-400">{totalEntrantes.toLocaleString("es-ES")}</p>
            </div>
          </div>

          <div className="mt-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <input
              type="text"
              placeholder="Buscar por SKU, ASIN o nombre..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full sm:w-96 rounded-lg border border-slate-800 bg-slate-900 px-4 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
            <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={onlyWithStock}
                onChange={(e) => setOnlyWithStock(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-indigo-500"
              />
              Solo mostrar artículos con stock activo ({rows.filter(r => r.fulfillable > 0 || r.reserved > 0 || r.inbound > 0).length})
            </label>
          </div>

          <div className="mt-4 overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/40">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-800 bg-slate-900/80 text-slate-400">
                <tr>
                  <th className="py-3 px-4 font-medium">SKU</th>
                  <th className="py-3 px-4 font-medium">ASIN</th>
                  <th className="py-3 px-4 font-medium">Producto</th>
                  <th className="py-3 px-4 font-medium text-right">Disponible</th>
                  <th className="py-3 px-4 font-medium text-right">Reservado</th>
                  <th className="py-3 px-4 font-medium text-right">En camino</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filtered.slice(0, 100).map((row) => (
                  <tr key={row.sku} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-2.5 px-4 font-mono text-xs text-indigo-300">{row.sku}</td>
                    <td className="py-2.5 px-4 font-mono text-xs text-slate-400">{row.asin}</td>
                    <td className="py-2.5 px-4 text-slate-200 max-w-md truncate" title={row.name}>{row.name || "-"}</td>
                    <td className="py-2.5 px-4 text-right font-semibold text-emerald-400">{row.fulfillable}</td>
                    <td className="py-2.5 px-4 text-right text-amber-400">{row.reserved}</td>
                    <td className="py-2.5 px-4 text-right text-blue-400">{row.inbound}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length > 100 && (
            <p className="mt-2 text-xs text-slate-500 text-center">
              Mostrando los primeros 100 de {filtered.length} productos filtrados. Usa el buscador para filtrar.
            </p>
          )}
        </>
      )}
    </main>
  );
}
