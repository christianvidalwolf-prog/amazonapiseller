"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface ListingItem {
  sku: string;
  asin: string;
  fnsku: string;
  name: string;
  total: number;
  fulfillable: number;
}

export default function ListingsPage() {
  const [items, setItems] = useState<ListingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch(`${API_URL}/api/listings`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => setItems(data.items || []))
      .catch((err) => setError(err instanceof Error ? err.message : "Error cargando catálogo"))
      .finally(() => setLoading(false));
  }, []);

  const filtered = items.filter((item) => {
    if (!search) return true;
    const term = search.toLowerCase();
    return (
      item.sku.toLowerCase().includes(term) ||
      item.asin.toLowerCase().includes(term) ||
      item.name.toLowerCase().includes(term)
    );
  });

  return (
    <main className="p-10 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Catálogo de Productos</h1>
          <p className="mt-1 text-sm text-slate-400">
            {items.length.toLocaleString("es-ES")} productos sincronizados con Amazon SP-API.
          </p>
        </div>
        <Link
          href="/listings/new"
          className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors shadow-sm"
        >
          + Alta de Producto
        </Link>
      </div>

      {loading && <p className="mt-6 text-slate-400">Cargando catálogo…</p>}
      {error && <p className="mt-6 text-red-400">Error: {error}</p>}

      {!loading && !error && (
        <>
          <div className="mt-6">
            <input
              type="text"
              placeholder="Buscar por SKU, ASIN o título del producto..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full sm:w-96 rounded-lg border border-slate-800 bg-slate-900 px-4 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div className="mt-4 overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/40">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-800 bg-slate-900/80 text-slate-400">
                <tr>
                  <th className="py-3 px-4 font-medium">SKU</th>
                  <th className="py-3 px-4 font-medium">ASIN</th>
                  <th className="py-3 px-4 font-medium">FNSKU</th>
                  <th className="py-3 px-4 font-medium">Título del Producto</th>
                  <th className="py-3 px-4 font-medium text-right">Disponible</th>
                  <th className="py-3 px-4 font-medium text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filtered.slice(0, 100).map((item) => (
                  <tr key={item.sku} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-2.5 px-4 font-mono text-xs text-indigo-300 font-semibold">{item.sku}</td>
                    <td className="py-2.5 px-4 font-mono text-xs text-slate-400">
                      <a
                        href={`https://www.amazon.es/dp/${item.asin}`}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-indigo-400 underline decoration-slate-700"
                      >
                        {item.asin}
                      </a>
                    </td>
                    <td className="py-2.5 px-4 font-mono text-xs text-slate-500">{item.fnsku || "-"}</td>
                    <td className="py-2.5 px-4 text-slate-200 max-w-md truncate" title={item.name}>
                      {item.name}
                    </td>
                    <td className="py-2.5 px-4 text-right font-medium text-slate-300">{item.fulfillable}</td>
                    <td className="py-2.5 px-4 text-right">
                      <a
                        href={`https://www.amazon.es/dp/${item.asin}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-indigo-400 hover:text-indigo-300"
                      >
                        Ver en Amazon ↗
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length > 100 && (
            <p className="mt-2 text-xs text-slate-500 text-center">
              Mostrando los primeros 100 de {filtered.length} productos filtrados. Usa el buscador para encontrar cualquier referencia.
            </p>
          )}
        </>
      )}
    </main>
  );
}
