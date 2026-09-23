"use client";

import { API_ORIGIN } from "@/lib/apiBase";
import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { usePrivacy } from "@/lib/PrivacyContext";

const API_URL = API_ORIGIN;

interface InventoryRow {
  sku: string;
  asin: string;
  name?: string;
  total?: number;
  fulfillable: number;
  reserved: number;
  inbound: number;
  price?: number;
  fulfillmentChannel?: "FBA" | "FBM";
  status?: string;
}

export default function InventoryPage() {
  const { isPrivacyMode, maskProductName, maskSku, maskAsin } = usePrivacy();
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState<"ALL" | "FBA" | "FBM">("ALL");
  const [onlyWithStock, setOnlyWithStock] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 50;

  useEffect(() => {
    fetch(`${API_URL}/api/inventory/snapshot`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => setRows(data.rows || []))
      .catch((err) => setError(err instanceof Error ? err.message : "Error cargando inventario"))
      .finally(() => setLoading(false));
  }, []);

  const stats = useMemo(() => {
    let fbaCount = 0;
    let fbmCount = 0;
    let totalDisponibles = 0;
    let totalReservados = 0;
    let totalEntrantes = 0;

    for (const r of rows) {
      if (r.fulfillmentChannel === "FBA") fbaCount++;
      else fbmCount++;

      totalDisponibles += r.fulfillable || 0;
      totalReservados += r.reserved || 0;
      totalEntrantes += r.inbound || 0;
    }

    return {
      total: rows.length,
      fbaCount,
      fbmCount,
      totalDisponibles,
      totalReservados,
      totalEntrantes,
    };
  }, [rows]);

  const filtered = useMemo(() => {
    return rows.filter((row) => {
      // Channel filter
      if (channelFilter === "FBA" && row.fulfillmentChannel !== "FBA") return false;
      if (channelFilter === "FBM" && row.fulfillmentChannel !== "FBM") return false;

      // Stock filter
      if (onlyWithStock && !(row.fulfillable > 0 || row.reserved > 0 || row.inbound > 0)) {
        return false;
      }

      // Search term
      if (!search) return true;
      const term = search.toLowerCase();
      return (
        row.sku.toLowerCase().includes(term) ||
        row.asin.toLowerCase().includes(term) ||
        (row.name && row.name.toLowerCase().includes(term))
      );
    });
  }, [rows, channelFilter, onlyWithStock, search]);

  const totalPages = Math.ceil(filtered.length / pageSize) || 1;
  const paginatedRows = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, page, pageSize]);

  return (
    <main className="p-10 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Inventario y Logística Global</h1>
          <p className="mt-1 text-sm text-slate-400">
            Vista unificada de todo tu catálogo ({stats.total.toLocaleString("es-ES")} productos) con logística FBA y FBM.
          </p>
        </div>
        <Link
          href="/listings"
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-all shadow-sm"
        >
          <span>📄</span> Subir Precios / Stock CSV
        </Link>
      </div>

      {loading && <p className="mt-6 text-slate-400">Cargando inventario completo…</p>}
      {error && <p className="mt-6 text-red-400">Error: {error}</p>}

      {!loading && !error && (
        <>
          {/* Top KPI Cards */}
          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
              <p className="text-sm text-slate-400">Catálogo Total</p>
              <p className="mt-1 text-2xl font-semibold text-slate-100">{stats.total.toLocaleString("es-ES")}</p>
              <p className="mt-1 text-xs text-slate-500">
                {stats.fbaCount.toLocaleString("es-ES")} FBA · {stats.fbmCount.toLocaleString("es-ES")} FBM
              </p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
              <p className="text-sm text-slate-400">Unidades Disponibles</p>
              <p className="mt-1 text-2xl font-semibold text-emerald-400">
                {stats.totalDisponibles.toLocaleString("es-ES")}
              </p>
              <p className="mt-1 text-xs text-slate-500">Listas para la venta</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
              <p className="text-sm text-slate-400">FBA Reservadas</p>
              <p className="mt-1 text-2xl font-semibold text-amber-400">
                {stats.totalReservados.toLocaleString("es-ES")}
              </p>
              <p className="mt-1 text-xs text-slate-500">En pedidos / transferencias</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
              <p className="text-sm text-slate-400">FBA En Camino</p>
              <p className="mt-1 text-2xl font-semibold text-blue-400">
                {stats.totalEntrantes.toLocaleString("es-ES")}
              </p>
              <p className="mt-1 text-xs text-slate-500">Inbound hacia centros logísticos</p>
            </div>
          </div>

          {/* Filters Bar */}
          <div className="mt-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              <input
                type="text"
                placeholder="Buscar por SKU, ASIN o título..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="w-full sm:w-80 rounded-lg border border-slate-800 bg-slate-900 px-4 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />

              {/* Logistics channel tabs */}
              <div className="inline-flex rounded-lg border border-slate-800 bg-slate-900/80 p-1 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setChannelFilter("ALL");
                    setPage(1);
                  }}
                  className={`rounded-md px-3 py-1 font-medium transition-colors ${
                    channelFilter === "ALL"
                      ? "bg-indigo-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  Todos ({stats.total.toLocaleString("es-ES")})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setChannelFilter("FBA");
                    setPage(1);
                  }}
                  className={`rounded-md px-3 py-1 font-medium transition-colors ${
                    channelFilter === "FBA"
                      ? "bg-amber-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  FBA ({stats.fbaCount.toLocaleString("es-ES")})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setChannelFilter("FBM");
                    setPage(1);
                  }}
                  className={`rounded-md px-3 py-1 font-medium transition-colors ${
                    channelFilter === "FBM"
                      ? "bg-sky-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  FBM ({stats.fbmCount.toLocaleString("es-ES")})
                </button>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={onlyWithStock}
                onChange={(e) => {
                  setOnlyWithStock(e.target.checked);
                  setPage(1);
                }}
                className="rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-indigo-500"
              />
              Solo mostrar artículos con stock disponible/activo
            </label>
          </div>

          {/* Table */}
          <div className="mt-4 overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/40">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-800 bg-slate-900/80 text-slate-400 text-xs uppercase tracking-wider">
                <tr>
                  <th className="py-3 px-4 font-semibold">SKU</th>
                  <th className="py-3 px-4 font-semibold">ASIN</th>
                  <th className="py-3 px-4 font-semibold">Producto</th>
                  <th className="py-3 px-4 font-semibold text-center">Canal</th>
                  <th className="py-3 px-4 font-semibold text-right">Precio</th>
                  <th className="py-3 px-4 font-semibold text-right">Disponible</th>
                  <th className="py-3 px-4 font-semibold text-right">Reservado</th>
                  <th className="py-3 px-4 font-semibold text-right">En camino</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {paginatedRows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-slate-400 text-sm">
                      No se encontraron productos con los filtros seleccionados.
                    </td>
                  </tr>
                ) : (
                  paginatedRows.map((row) => {
                    const displaySku = maskSku(row.sku);
                    const displayAsin = maskAsin(row.asin);
                    const displayName = maskProductName(row.name, row.sku);

                    return (
                      <tr key={row.sku} className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-2.5 px-4 font-mono text-xs text-indigo-300 font-medium">
                          {displaySku}
                        </td>
                        <td className="py-2.5 px-4 font-mono text-xs text-slate-400">
                          {row.asin ? (
                            isPrivacyMode ? (
                              <span>{displayAsin}</span>
                            ) : (
                              <a
                                href={`https://www.amazon.es/dp/${row.asin}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:text-indigo-400 underline decoration-slate-700 hover:decoration-indigo-400"
                              >
                                {displayAsin}
                              </a>
                            )
                          ) : (
                            "-"
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-slate-200 max-w-sm truncate" title={displayName}>
                          {displayName}
                        </td>
                        <td className="py-2.5 px-4 text-center">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold ${
                              row.fulfillmentChannel === "FBA"
                                ? "bg-amber-950/80 text-amber-300 border border-amber-800/50"
                                : "bg-sky-950/80 text-sky-300 border border-sky-800/50"
                            }`}
                          >
                            {row.fulfillmentChannel || "FBM"}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono text-slate-200">
                          {typeof row.price === "number" && row.price > 0
                            ? `${row.price.toFixed(2)} €`
                            : "-"}
                        </td>
                        <td className="py-2.5 px-4 text-right font-semibold text-emerald-400">
                          {row.fulfillable.toLocaleString("es-ES")}
                        </td>
                        <td className="py-2.5 px-4 text-right text-amber-400">
                          {row.reserved > 0 ? row.reserved.toLocaleString("es-ES") : "-"}
                        </td>
                        <td className="py-2.5 px-4 text-right text-blue-400">
                          {row.inbound > 0 ? row.inbound.toLocaleString("es-ES") : "-"}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Controls */}
          {filtered.length > pageSize && (
            <div className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-400">
              <span>
                Mostrando {((page - 1) * pageSize + 1).toLocaleString("es-ES")} -{" "}
                {Math.min(page * pageSize, filtered.length).toLocaleString("es-ES")} de{" "}
                {filtered.length.toLocaleString("es-ES")} productos
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage(1)}
                  className="px-2.5 py-1 rounded border border-slate-800 bg-slate-900 hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none text-slate-200"
                >
                  « Inicio
                </button>
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="px-2.5 py-1 rounded border border-slate-800 bg-slate-900 hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none text-slate-200"
                >
                  ‹ Anterior
                </button>
                <span className="px-2 py-1 text-slate-300 font-medium">
                  Página {page} de {totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="px-2.5 py-1 rounded border border-slate-800 bg-slate-900 hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none text-slate-200"
                >
                  Siguiente ›
                </button>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage(totalPages)}
                  className="px-2.5 py-1 rounded border border-slate-800 bg-slate-900 hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none text-slate-200"
                >
                  Final »
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}
