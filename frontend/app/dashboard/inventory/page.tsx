"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ExcelColumnHeader, type SortDirection } from "@/components/inventory/ExcelColumnHeader";
import { API_ORIGIN } from "@/lib/apiBase";
import { downloadXlsx } from "@/lib/exportXlsx";
import { usePrivacy } from "@/lib/PrivacyContext";

const API_URL = API_ORIGIN;

const MARKETPLACES = [
  { id: "A1RKKUPIHCS9HS", name: "España", currency: "EUR" },
  { id: "A13V1IB3VIYZZH", name: "Francia", currency: "EUR" },
  { id: "APJ6JRA9NG5V4", name: "Italia", currency: "EUR" },
  { id: "A1PA6795UKMFR9", name: "Alemania", currency: "EUR" },
];

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

type ColumnKey = "sku" | "asin" | "name" | "channel" | "price" | "fulfillable" | "reserved" | "inbound";

export default function InventoryPage() {
  const { isPrivacyMode, maskProductName, maskSku, maskAsin } = usePrivacy();
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState<"ALL" | "FBA" | "FBM">("ALL");
  const [onlyWithStock, setOnlyWithStock] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [marketplaceId, setMarketplaceId] = useState(MARKETPLACES[0].id);
  const [editingSku, setEditingSku] = useState<string | null>(null);
  const [editingPrice, setEditingPrice] = useState("");
  const [savingPrice, setSavingPrice] = useState<string | null>(null);
  const [submittedPrices, setSubmittedPrices] = useState<Record<string, number>>({});
  const [priceMessage, setPriceMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // Column-specific Excel filters: map of columnKey -> Set of selected values
  const [columnFilters, setColumnFilters] = useState<Record<ColumnKey, Set<string>>>({
    sku: new Set(),
    asin: new Set(),
    name: new Set(),
    channel: new Set(),
    price: new Set(),
    fulfillable: new Set(),
    reserved: new Set(),
    inbound: new Set(),
  });

  // Sorting state: which column and direction
  const [sortColumn, setSortColumn] = useState<ColumnKey | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`${API_URL}/api/inventory/snapshot?marketplaceId=${encodeURIComponent(marketplaceId)}&includePrices=false`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => setRows(data.rows || []))
      .catch((err) => setError(err instanceof Error ? err.message : "Error cargando inventario"))
      .finally(() => {
        setLoading(false);
        // Live marketplace prices are loaded in the background so they never
        // block the inventory table from appearing.
        fetch(`${API_URL}/api/inventory/snapshot?marketplaceId=${encodeURIComponent(marketplaceId)}&includePrices=true`)
          .then((res) => res.ok ? res.json() : null)
          .then((data) => { if (data?.rows) setRows(data.rows); })
          .catch(() => undefined);
      });
  }, [marketplaceId]);

  const savePrice = async (row: InventoryRow) => {
    const normalized = editingPrice.trim().replace(",", ".");
    const price = Number(normalized);
    if (!Number.isFinite(price) || price <= 0) {
      setPriceMessage({ text: "Introduce un precio válido mayor a 0 (ej: 9.90 o 9,90).", type: "error" });
      return;
    }
    setSavingPrice(row.sku);
    setPriceMessage(null);
    try {
      const response = await fetch(`${API_URL}/api/listings/items/${encodeURIComponent(row.sku)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ price, marketplaceId, currency: "EUR" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const firstIssue = body.issues?.[0];
        const firstError = body.errors?.[0];
        const errorDetail =
          body.error ||
          (firstError ? `${firstError.message}${firstError.details ? ` (${firstError.details})` : ""}` : null) ||
          (firstIssue ? `${firstIssue.message}${firstIssue.attributeNames ? ` [${firstIssue.attributeNames.join(", ")}]` : ""}` : null) ||
          body.message;
        throw new Error(errorDetail || "Amazon no aceptó la actualización.");
      }
      setRows((current) => current.map((item) => item.sku === row.sku ? { ...item, price } : item));
      setSubmittedPrices((current) => ({ ...current, [row.sku]: price }));
      setEditingSku(null);
      const submissionId = body.submissionId || body.submission_id;
      setPriceMessage({
        text: `✓ Precio de ${row.sku} (${price.toFixed(2)} €) enviado correctamente a Amazon${submissionId ? ` · Submission ID: ${submissionId}` : ""}. Amazon suele tardar entre 2 y 15 minutos en reflejarlo en la ficha pública.`,
        type: "success",
      });
    } catch (error) {
      setPriceMessage({
        text: error instanceof Error ? error.message : "No se pudo actualizar el precio en Amazon.",
        type: "error",
      });
    } finally {
      setSavingPrice(null);
    }
  };

  const loadPriceStatus = async (row: InventoryRow) => {
    try {
      const response = await fetch(`${API_URL}/api/listings/items/${encodeURIComponent(row.sku)}/status?marketplaceId=${encodeURIComponent(marketplaceId)}`);
      const data = await response.json();
      if (data.submission?.status === "ACCEPTED" || data.submission?.status === "VALID") {
        setSubmittedPrices((current) => ({ ...current, [row.sku]: row.price ?? 0 }));
      }
    } catch {
      // El estado persistido es complementario; el usuario puede seguir editando.
    }
  };

  // Base raw values for each column to feed distinct dropdowns
  const columnRawValues = useMemo(() => {
    const skuVals: string[] = [];
    const asinVals: string[] = [];
    const nameVals: string[] = [];
    const channelVals: string[] = [];
    const priceVals: (string | number)[] = [];
    const fulfillableVals: number[] = [];
    const reservedVals: number[] = [];
    const inboundVals: number[] = [];

    for (const r of rows) {
      skuVals.push(maskSku(r.sku));
      asinVals.push(r.asin ? maskAsin(r.asin) : "");
      nameVals.push(maskProductName(r.name, r.sku));
      channelVals.push(r.fulfillmentChannel || "FBM");
      priceVals.push(typeof r.price === "number" && r.price > 0 ? r.price.toFixed(2) : "");
      fulfillableVals.push(r.fulfillable || 0);
      reservedVals.push(r.reserved || 0);
      inboundVals.push(r.inbound || 0);
    }

    return {
      sku: skuVals,
      asin: asinVals,
      name: nameVals,
      channel: channelVals,
      price: priceVals,
      fulfillable: fulfillableVals,
      reserved: reservedVals,
      inbound: inboundVals,
    };
  }, [rows, maskSku, maskAsin, maskProductName]);

  // Overall KPIs calculation (based on all loaded rows)
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

  // Helper to format a cell's string representation matching the Excel filter value
  const getCellFilterString = (row: InventoryRow, col: ColumnKey): string => {
    switch (col) {
      case "sku":
        return maskSku(row.sku);
      case "asin":
        return row.asin ? maskAsin(row.asin) : "(Vacías / Empty)";
      case "name": {
        const n = maskProductName(row.name, row.sku);
        return n && n !== "-" ? n : "(Vacías / Empty)";
      }
      case "channel":
        return row.fulfillmentChannel || "FBM";
      case "price":
        return typeof row.price === "number" && row.price > 0 ? row.price.toFixed(2) : "(Vacías / Empty)";
      case "fulfillable":
        return String(row.fulfillable ?? 0);
      case "reserved":
        return String(row.reserved ?? 0);
      case "inbound":
        return String(row.inbound ?? 0);
    }
  };

  // Check if any Excel column filter is currently applied
  const activeExcelFiltersCount = useMemo(() => {
    let count = 0;
    for (const key of Object.keys(columnFilters) as ColumnKey[]) {
      const selected = columnFilters[key];
      if (selected.size > 0) {
        // If it's smaller than the distinct count in columnRawValues, it is active
        const distinct = new Set(columnRawValues[key].map((v) => (v === "" || v === null || v === undefined ? "(Vacías / Empty)" : String(v))));
        if (selected.size < distinct.size) {
          count++;
        }
      }
    }
    return count;
  }, [columnFilters, columnRawValues]);

  const resetAllExcelFilters = () => {
    setColumnFilters({
      sku: new Set(),
      asin: new Set(),
      name: new Set(),
      channel: new Set(),
      price: new Set(),
      fulfillable: new Set(),
      reserved: new Set(),
      inbound: new Set(),
    });
    setSortColumn(null);
    setSortDirection(null);
    setSearch("");
    setChannelFilter("ALL");
    setOnlyWithStock(false);
    setPage(1);
  };

  // Filter rows by global filters + Excel column filters
  const filtered = useMemo(() => {
    return rows.filter((row) => {
      // 1. Channel filter tab
      if (channelFilter === "FBA" && row.fulfillmentChannel !== "FBA") return false;
      if (channelFilter === "FBM" && row.fulfillmentChannel !== "FBM") return false;

      // 2. Stock checkbox filter
      if (onlyWithStock && !(row.fulfillable > 0 || row.reserved > 0 || row.inbound > 0)) {
        return false;
      }

      // 3. Global search bar
      if (search.trim()) {
        const term = search.toLowerCase();
        const skuStr = maskSku(row.sku).toLowerCase();
        const asinStr = (row.asin ? maskAsin(row.asin) : "").toLowerCase();
        const nameStr = maskProductName(row.name, row.sku).toLowerCase();
        if (!skuStr.includes(term) && !asinStr.includes(term) && !nameStr.includes(term)) {
          return false;
        }
      }

      // 4. Excel-style column filters
      for (const colKey of Object.keys(columnFilters) as ColumnKey[]) {
        const selected = columnFilters[colKey];
        if (selected && selected.size > 0) {
          const cellStr = getCellFilterString(row, colKey);
          if (!selected.has(cellStr)) {
            return false;
          }
        }
      }

      return true;
    });
  }, [rows, channelFilter, onlyWithStock, search, columnFilters, maskSku, maskAsin, maskProductName]);

  // Sort rows based on sortColumn and sortDirection
  const sorted = useMemo(() => {
    if (!sortColumn || !sortDirection) return filtered;

    const copy = [...filtered];
    copy.sort((a, b) => {
      let valA: string | number = 0;
      let valB: string | number = 0;

      switch (sortColumn) {
        case "sku":
          valA = maskSku(a.sku).toLowerCase();
          valB = maskSku(b.sku).toLowerCase();
          break;
        case "asin":
          valA = (a.asin || "").toLowerCase();
          valB = (b.asin || "").toLowerCase();
          break;
        case "name":
          valA = maskProductName(a.name, a.sku).toLowerCase();
          valB = maskProductName(b.name, b.sku).toLowerCase();
          break;
        case "channel":
          valA = a.fulfillmentChannel || "FBM";
          valB = b.fulfillmentChannel || "FBM";
          break;
        case "price":
          valA = a.price ?? 0;
          valB = b.price ?? 0;
          break;
        case "fulfillable":
          valA = a.fulfillable ?? 0;
          valB = b.fulfillable ?? 0;
          break;
        case "reserved":
          valA = a.reserved ?? 0;
          valB = b.reserved ?? 0;
          break;
        case "inbound":
          valA = a.inbound ?? 0;
          valB = b.inbound ?? 0;
          break;
      }

      if (typeof valA === "number" && typeof valB === "number") {
        return sortDirection === "asc" ? valA - valB : valB - valA;
      }

      const strA = String(valA);
      const strB = String(valB);
      const cmp = strA.localeCompare(strB, undefined, { numeric: true, sensitivity: "base" });
      return sortDirection === "asc" ? cmp : -cmp;
    });

    return copy;
  }, [filtered, sortColumn, sortDirection, maskSku, maskProductName]);

  const totalPages = Math.ceil(sorted.length / pageSize) || 1;
  const paginatedRows = useMemo(() => {
    const start = (page - 1) * pageSize;
    return sorted.slice(start, start + pageSize);
  }, [sorted, page, pageSize]);

  // Excel Subtotals: calculated over all filtered rows for each column
  const filteredTotals = useMemo(() => {
    let sumPrice = 0;
    let pricedCount = 0;
    let sumFulfillable = 0;
    let sumReserved = 0;
    let sumInbound = 0;
    let fbaCount = 0;
    let fbmCount = 0;
    const uniqueAsins = new Set<string>();

    for (const r of filtered) {
      if (typeof r.price === "number" && r.price > 0) {
        sumPrice += r.price;
        pricedCount++;
      }
      sumFulfillable += r.fulfillable || 0;
      sumReserved += r.reserved || 0;
      sumInbound += r.inbound || 0;
      if (r.fulfillmentChannel === "FBA") fbaCount++;
      else fbmCount++;
      if (r.asin) uniqueAsins.add(r.asin);
    }

    const avgPrice = pricedCount > 0 ? (sumPrice / pricedCount).toFixed(2) : "0.00";

    return {
      sku: `${filtered.length.toLocaleString("es-ES")} SKUs`,
      asin: `${uniqueAsins.size.toLocaleString("es-ES")} ASINs`,
      name: `${filtered.length.toLocaleString("es-ES")} arts`,
      channel: `${fbaCount.toLocaleString("es-ES")} FBA · ${fbmCount.toLocaleString("es-ES")} FBM`,
      price: `${avgPrice} €`,
      priceLabel: pricedCount > 0 ? `Med. (${pricedCount})` : undefined,
      fulfillable: sumFulfillable.toLocaleString("es-ES"),
      fulfillableLabel: "Suma",
      reserved: sumReserved.toLocaleString("es-ES"),
      reservedLabel: "Suma",
      inbound: sumInbound.toLocaleString("es-ES"),
      inboundLabel: "Suma",
    };
  }, [filtered]);

  const updateColumnFilter = (col: ColumnKey, newSelected: Set<string>) => {
    setColumnFilters((prev) => ({
      ...prev,
      [col]: newSelected,
    }));
    setPage(1);
  };

  const updateColumnSort = (col: ColumnKey, dir: SortDirection) => {
    if (dir === null) {
      if (sortColumn === col) {
        setSortColumn(null);
        setSortDirection(null);
      }
    } else {
      setSortColumn(col);
      setSortDirection(dir);
    }
  };

  // Export the rows currently visible in the table (all filtered + sorted rows,
  // not just the current page) to a downloadable .xlsx file.
  const handleExportToExcel = () => {
    if (sorted.length === 0) return;

    const headers = ["SKU", "ASIN", "Producto", "Canal", "Precio", "Disponible", "Reservado", "En camino"];
    const data = sorted.map((row) => [
      row.sku,
      row.asin || "",
      row.name || "",
      row.fulfillmentChannel || "FBM",
      typeof row.price === "number" && row.price > 0 ? row.price : "",
      row.fulfillable ?? 0,
      row.reserved ?? 0,
      row.inbound ?? 0,
    ]);

    const date = new Date().toISOString().slice(0, 10);
    downloadXlsx({
      filename: `inventario_${date}`,
      sheetName: "Inventario",
      headers,
      rows: data,
    });
  };

  return (
    <main className="p-6 sm:p-10 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <span>Inventario y Logística Global</span>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-indigo-950/80 text-indigo-300 border border-indigo-700/60 font-mono font-medium">
              Excel Filtering Pro
            </span>
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Vista unificada de todo tu catálogo ({filtered.length.toLocaleString("es-ES")} productos) con logística FBA y FBM.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            Marketplace:
            <select
              value={marketplaceId}
              onChange={(event) => setMarketplaceId(event.target.value)}
              className="rounded border border-slate-800 bg-slate-900 px-2.5 py-2 text-slate-200 focus:border-indigo-500 focus:outline-none"
            >
              {MARKETPLACES.map((marketplace) => <option key={marketplace.id} value={marketplace.id}>{marketplace.name}</option>)}
            </select>
          </label>
          {activeExcelFiltersCount > 0 && (
            <button
              type="button"
              onClick={resetAllExcelFilters}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-rose-950/80 hover:bg-rose-900/80 text-rose-300 border border-rose-700/60 transition-all shadow-sm"
            >
              <span>✕</span> Limpiar {activeExcelFiltersCount} Filtro{activeExcelFiltersCount > 1 ? "s" : ""} Excel
            </button>
          )}
          <button
            type="button"
            onClick={handleExportToExcel}
            disabled={loading || !!error || sorted.length === 0}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:pointer-events-none text-white transition-all shadow-sm"
          >
            <span>⬇</span> Exportar a Excel ({sorted.length.toLocaleString("es-ES")})
          </button>
          <Link
            href="/listings"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-all shadow-sm"
          >
            <span>📄</span> Subir Precios / Stock CSV
          </Link>
        </div>
      </div>

      {loading && <p className="mt-6 text-slate-400">Cargando inventario completo…</p>}
      {error && <p className="mt-6 text-red-400">Error: {error}</p>}
      {priceMessage && (
        <div
          className={`mt-4 flex items-center justify-between rounded-lg border px-4 py-3 text-sm shadow-sm transition-all ${
            priceMessage.type === "success"
              ? "border-emerald-800 bg-emerald-950/70 text-emerald-200"
              : "border-rose-800 bg-rose-950/70 text-rose-200"
          }`}
        >
          <div className="flex items-center gap-2">
            <span>{priceMessage.type === "success" ? "✅" : "⚠️"}</span>
            <span>{priceMessage.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setPriceMessage(null)}
            className="text-xs opacity-75 hover:opacity-100 ml-4 px-1"
          >
            ✕
          </button>
        </div>
      )}

      {!loading && !error && (
        <>
          {/* Top KPI Cards */}
          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
              <p className="text-sm text-slate-400">Productos según filtros</p>
              <p className="mt-1 text-2xl font-semibold text-slate-100">{filtered.length.toLocaleString("es-ES")}</p>
              <p className="mt-1 text-xs text-slate-500">
                {filtered.filter((row) => row.fulfillmentChannel === "FBA").length.toLocaleString("es-ES")} FBA · {filtered.filter((row) => row.fulfillmentChannel !== "FBA").length.toLocaleString("es-ES")} FBM
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

          {/* Quick Filters Bar */}
          <div className="mt-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              <div className="relative w-full sm:w-80">
                <input
                  type="text"
                  placeholder="Buscador rápido (SKU, ASIN o título)..."
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  className="w-full rounded-lg border border-slate-800 bg-slate-900 px-4 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="absolute right-3 top-2.5 text-slate-400 hover:text-white text-xs"
                  >
                    ✕
                  </button>
                )}
              </div>

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

            <div className="flex items-center gap-4">
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
                Solo mostrar con stock disponible/activo
              </label>

              <div className="flex items-center gap-1.5 text-xs text-slate-400">
                <span>Filas:</span>
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setPage(1);
                  }}
                  className="rounded border border-slate-800 bg-slate-900 px-2 py-1 text-slate-200 focus:border-indigo-500 focus:outline-none"
                >
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={200}>200</option>
                </select>
              </div>
            </div>
          </div>

          {/* Active Filter Chips Banner */}
          {(activeExcelFiltersCount > 0 || search || channelFilter !== "ALL" || onlyWithStock) && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-400 font-medium">Filtros activos:</span>
              {channelFilter !== "ALL" && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 text-slate-200 border border-slate-700">
                  Canal: <strong>{channelFilter}</strong>
                  <button type="button" onClick={() => setChannelFilter("ALL")} className="text-slate-400 hover:text-white">✕</button>
                </span>
              )}
              {onlyWithStock && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-950 text-emerald-300 border border-emerald-800">
                  Solo con stock
                  <button type="button" onClick={() => setOnlyWithStock(false)} className="text-emerald-400 hover:text-white">✕</button>
                </span>
              )}
              {search && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 text-slate-200 border border-slate-700">
                  Búsqueda: <strong>{search}</strong>
                  <button type="button" onClick={() => setSearch("")} className="text-slate-400 hover:text-white">✕</button>
                </span>
              )}
              {sortColumn && sortDirection && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-indigo-950 text-indigo-300 border border-indigo-800">
                  Orden: <strong>{sortColumn.toUpperCase()} ({sortDirection === "asc" ? "▲ Asc" : "▼ Desc"})</strong>
                  <button type="button" onClick={() => { setSortColumn(null); setSortDirection(null); }} className="text-indigo-400 hover:text-white">✕</button>
                </span>
              )}
              {activeExcelFiltersCount > 0 && (
                <button
                  type="button"
                  onClick={resetAllExcelFilters}
                  className="text-xs text-rose-400 hover:underline ml-2"
                >
                  Restablecer todos los filtros
                </button>
              )}
            </div>
          )}

          {/* Table Container with Overflow Protection */}
          <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900/40 pb-20">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-800 bg-slate-900/80 text-slate-400 text-xs uppercase tracking-wider">
                <tr>
                  <ExcelColumnHeader
                    title="SKU"
                    columnKey="sku"
                    values={columnRawValues.sku}
                    selectedValues={columnFilters.sku}
                    onSelectionChange={(s) => updateColumnFilter("sku", s)}
                    sortDirection={sortColumn === "sku" ? sortDirection : null}
                    onSortChange={(dir) => updateColumnSort("sku", dir)}
                    align="left"
                    subtotal={filteredTotals.sku}
                  />
                  <ExcelColumnHeader
                    title="ASIN"
                    columnKey="asin"
                    values={columnRawValues.asin}
                    selectedValues={columnFilters.asin}
                    onSelectionChange={(s) => updateColumnFilter("asin", s)}
                    sortDirection={sortColumn === "asin" ? sortDirection : null}
                    onSortChange={(dir) => updateColumnSort("asin", dir)}
                    align="left"
                    subtotal={filteredTotals.asin}
                  />
                  <ExcelColumnHeader
                    title="Producto"
                    columnKey="name"
                    values={columnRawValues.name}
                    selectedValues={columnFilters.name}
                    onSelectionChange={(s) => updateColumnFilter("name", s)}
                    sortDirection={sortColumn === "name" ? sortDirection : null}
                    onSortChange={(dir) => updateColumnSort("name", dir)}
                    align="left"
                    subtotal={filteredTotals.name}
                  />
                  <ExcelColumnHeader
                    title="Canal"
                    columnKey="channel"
                    values={columnRawValues.channel}
                    selectedValues={columnFilters.channel}
                    onSelectionChange={(s) => updateColumnFilter("channel", s)}
                    sortDirection={sortColumn === "channel" ? sortDirection : null}
                    onSortChange={(dir) => updateColumnSort("channel", dir)}
                    align="center"
                    subtotal={filteredTotals.channel}
                  />
                  <ExcelColumnHeader
                    title="Precio"
                    columnKey="price"
                    values={columnRawValues.price}
                    selectedValues={columnFilters.price}
                    onSelectionChange={(s) => updateColumnFilter("price", s)}
                    sortDirection={sortColumn === "price" ? sortDirection : null}
                    onSortChange={(dir) => updateColumnSort("price", dir)}
                    align="right"
                    isNumeric={true}
                    subtotal={filteredTotals.price}
                    subtotalLabel={filteredTotals.priceLabel}
                  />
                  <ExcelColumnHeader
                    title="Disponible"
                    columnKey="fulfillable"
                    values={columnRawValues.fulfillable}
                    selectedValues={columnFilters.fulfillable}
                    onSelectionChange={(s) => updateColumnFilter("fulfillable", s)}
                    sortDirection={sortColumn === "fulfillable" ? sortDirection : null}
                    onSortChange={(dir) => updateColumnSort("fulfillable", dir)}
                    align="right"
                    isNumeric={true}
                    subtotal={filteredTotals.fulfillable}
                    subtotalLabel={filteredTotals.fulfillableLabel}
                  />
                  <ExcelColumnHeader
                    title="Reservado"
                    columnKey="reserved"
                    values={columnRawValues.reserved}
                    selectedValues={columnFilters.reserved}
                    onSelectionChange={(s) => updateColumnFilter("reserved", s)}
                    sortDirection={sortColumn === "reserved" ? sortDirection : null}
                    onSortChange={(dir) => updateColumnSort("reserved", dir)}
                    align="right"
                    isNumeric={true}
                    subtotal={filteredTotals.reserved}
                    subtotalLabel={filteredTotals.reservedLabel}
                  />
                  <ExcelColumnHeader
                    title="En camino"
                    columnKey="inbound"
                    values={columnRawValues.inbound}
                    selectedValues={columnFilters.inbound}
                    onSelectionChange={(s) => updateColumnFilter("inbound", s)}
                    sortDirection={sortColumn === "inbound" ? sortDirection : null}
                    onSortChange={(dir) => updateColumnSort("inbound", dir)}
                    align="right"
                    isNumeric={true}
                    subtotal={filteredTotals.inbound}
                    subtotalLabel={filteredTotals.inboundLabel}
                  />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {paginatedRows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-slate-400 text-sm">
                      <div className="flex flex-col items-center justify-center gap-2">
                        <span className="text-2xl">🔍</span>
                        <span>No se encontraron productos con los filtros seleccionados.</span>
                        <button
                          type="button"
                          onClick={resetAllExcelFilters}
                          className="mt-1 text-xs text-indigo-400 hover:underline"
                        >
                          Limpiar todos los filtros y búsquedas
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  paginatedRows.map((row) => {
                    const displaySku = maskSku(row.sku);
                    const displayAsin = maskAsin(row.asin);
                    const displayName = maskProductName(row.name, row.sku);

                    return (
                      <tr key={row.sku} className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-2.5 px-3 font-mono text-xs text-indigo-300 font-medium whitespace-nowrap">
                          {displaySku}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-xs text-slate-400 whitespace-nowrap">
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
                        <td className="py-2.5 px-3 text-slate-200 max-w-md truncate" title={displayName}>
                          {displayName}
                        </td>
                        <td className="py-2.5 px-3 text-center">
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
                        <td className="py-2.5 px-3 text-right font-mono text-slate-200">
                          {editingSku === row.sku ? (
                            <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                              <div className="relative">
                                  <input
                                    value={editingPrice}
                                    onChange={(event) => setEditingPrice(event.target.value)}
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter") {
                                        event.preventDefault();
                                        void savePrice(row);
                                      } else if (event.key === "Escape") {
                                        setEditingSku(null);
                                      }
                                    }}
                                    type="text"
                                    inputMode="decimal"
                                    placeholder="0.00"
                                    className="w-24 rounded border border-indigo-500 bg-slate-950 px-2 py-1 pr-5 text-right text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                                    autoFocus
                                  />
                                <span className="absolute right-2 top-1 text-xs text-slate-400 pointer-events-none">€</span>
                              </div>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void savePrice(row);
                                }}
                                disabled={savingPrice === row.sku}
                                className="rounded bg-emerald-600 hover:bg-emerald-500 px-2.5 py-1 text-[11px] font-bold text-white shadow-sm disabled:opacity-50 transition-colors flex items-center gap-1"
                                title="Enviar precio a Amazon SP-API"
                              >
                                {savingPrice === row.sku ? "Enviando…" : "✓ Guardar"}
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingSku(null)}
                                className="px-1.5 py-1 text-slate-400 hover:text-slate-200 text-xs"
                                title="Cancelar"
                              >
                                ✕
                              </button>
                            </div>
                          ) : (
                            <div className="group/price flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingSku(row.sku);
                                  void loadPriceStatus(row);
                                  setSubmittedPrices((current) => {
                                    const next = { ...current };
                                    delete next[row.sku];
                                    return next;
                                  });
                                  setEditingPrice(typeof row.price === "number" && row.price > 0 ? row.price.toFixed(2) : "");
                                  setPriceMessage(null);
                                }}
                                className="rounded px-2 py-1 text-right font-medium text-slate-200 group-hover/price:bg-slate-800 group-hover/price:text-indigo-300 transition-colors flex items-center gap-1.5"
                                title="Haz clic para modificar el precio en Amazon"
                              >
                                <span>{typeof row.price === "number" && row.price > 0 ? `${row.price.toFixed(2)} €` : "-"}</span>
                                <span className="text-[10px] opacity-0 group-hover/price:opacity-100 text-indigo-400 transition-opacity">✏️</span>
                              </button>
                              {submittedPrices[row.sku] !== undefined && (
                                <span
                                  className="rounded border border-emerald-700/60 bg-emerald-950/70 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300 shadow-sm"
                                  title="Precio enviado y aceptado por Amazon SP-API"
                                >
                                  ✓ Enviado
                                </span>
                              )}
                            </div>
                          )}
                          {savingPrice === row.sku && (
                            <div className="mt-0.5 text-[10px] text-amber-300 animate-pulse text-right">
                              Enviando a Amazon…
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right font-semibold text-emerald-400">
                          {row.fulfillable.toLocaleString("es-ES")}
                        </td>
                        <td className="py-2.5 px-3 text-right text-amber-400">
                          {row.reserved > 0 ? row.reserved.toLocaleString("es-ES") : "-"}
                        </td>
                        <td className="py-2.5 px-3 text-right text-blue-400">
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
          {sorted.length > pageSize && (
            <div className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-400">
              <span>
                Mostrando {((page - 1) * pageSize + 1).toLocaleString("es-ES")} -{" "}
                {Math.min(page * pageSize, sorted.length).toLocaleString("es-ES")} de{" "}
                {sorted.length.toLocaleString("es-ES")} productos filtrados (Total: {rows.length.toLocaleString("es-ES")})
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
