"use client";

import { useEffect, useState } from "react";
import { API_ORIGIN } from "@/lib/apiBase";
import { usePrivacy } from "@/lib/PrivacyContext";

const API_URL = API_ORIGIN;

interface ListingItem {
  sku: string;
  asin: string;
  fnsku: string;
  name: string;
  total: number;
  fulfillable: number;
}

const COUNTRIES = [
  { code: "ES", name: "España", marketplaceId: "A1RKKUPIHCS9HS", flag: "🇪🇸" },
  { code: "FR", name: "Francia", marketplaceId: "A13V1IB3VIYZZH", flag: "🇫🇷" },
  { code: "IT", name: "Italia", marketplaceId: "APJ6JRA9NG5V4", flag: "🇮🇹" },
  { code: "DE", name: "Alemania", marketplaceId: "A1PA6795UKMFR9", flag: "🇩🇪" },
];

export default function ListingsPage() {
  const { isPrivacyMode, maskProductName, maskSku, maskAsin } = usePrivacy();
  const [items, setItems] = useState<ListingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Modal de actualización individual
  const [editingItem, setEditingItem] = useState<ListingItem | null>(null);
  const [editCountry, setEditCountry] = useState("ES");
  const [editPrice, setEditPrice] = useState("");
  const [editStock, setEditStock] = useState("");
  const [editLeadTime, setEditLeadTime] = useState("2");
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Modal de subida de CSV
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [csvCountry, setCsvCountry] = useState("ES");
  const [csvContent, setCsvContent] = useState("");
  const [isDryRun, setIsDryRun] = useState(false);
  const [processingCsv, setProcessingCsv] = useState(false);
  const [csvResults, setCsvResults] = useState<Array<{ sku: string; status: "success" | "error"; message: string }> | null>(null);

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

  const handleOpenEdit = (item: ListingItem) => {
    setEditingItem(item);
    setEditPrice("");
    setEditStock("");
    setEditLeadTime("2");
    setSaveSuccess(null);
    setSaveError(null);
  };

  const handleSaveEdit = async () => {
    if (!editingItem) return;
    if (!editPrice && !editStock) {
      setSaveError("Introduce al menos un precio o una cantidad de stock.");
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);

    const countryObj = COUNTRIES.find((c) => c.code === editCountry) || COUNTRIES[0];

    try {
      const res = await fetch(`${API_URL}/api/listings/items/${encodeURIComponent(editingItem.sku)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          price: editPrice ? Number.parseFloat(editPrice.replace(",", ".")) : undefined,
          stock: editStock ? Number.parseInt(editStock, 10) : undefined,
          leadTimeDays: editLeadTime ? Number.parseInt(editLeadTime, 10) : 2,
          marketplaceId: countryObj.marketplaceId,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || (data.errors && data.errors[0]?.message) || `Error HTTP ${res.status}`);
      }

      setSaveSuccess(`¡Actualización aceptada por Amazon para ${countryObj.name}! (ID: ${data.submissionId || "OK"})`);
      setTimeout(() => {
        if (setEditingItem) setEditingItem(null);
      }, 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Error al actualizar en Amazon SP-API");
    } finally {
      setSaving(false);
    }
  };

  const handleProcessCsv = async () => {
    if (!csvContent.trim()) return;

    setProcessingCsv(true);
    setCsvResults(null);

    const countryObj = COUNTRIES.find((c) => c.code === csvCountry) || COUNTRIES[0];
    const lines = csvContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const results: Array<{ sku: string; status: "success" | "error"; message: string }> = [];

    // Parse header
    const delimiter = lines[0].includes(";") ? ";" : ",";
    const header = lines[0].split(delimiter).map((h) => h.trim().toLowerCase());
    const skuIdx = header.indexOf("sku");
    const priceIdx = header.findIndex((h) => h === "precio" || h === "price");
    const stockIdx = header.findIndex((h) => h === "stock" || h === "cantidad" || h === "quantity");
    const leadIdx = header.findIndex((h) => h === "lead_time_days" || h === "lead_time");
    const countryIdx = header.findIndex((h) => h === "pais" || h === "country" || h === "marketplace");

    if (skuIdx === -1) {
      setProcessingCsv(false);
      alert("El CSV debe tener al menos una columna llamada 'sku'.");
      return;
    }

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("#")) continue;
      const parts = line.split(delimiter).map((p) => p.trim());
      const sku = parts[skuIdx];
      if (!sku) continue;

      const rawPrice = priceIdx !== -1 ? parts[priceIdx] : undefined;
      const rawStock = stockIdx !== -1 ? parts[stockIdx] : undefined;
      const rawLead = leadIdx !== -1 ? parts[leadIdx] : "2";
      const rowCountry = countryIdx !== -1 && parts[countryIdx] ? parts[countryIdx].toUpperCase() : editCountry;

      const targetCountry = COUNTRIES.find((c) => c.code === rowCountry) || countryObj;

      const price = rawPrice ? Number.parseFloat(rawPrice.replace(",", ".")) : undefined;
      const stock = rawStock ? Number.parseInt(rawStock, 10) : undefined;
      const leadTime = rawLead ? Number.parseInt(rawLead, 10) : 2;

      if (price === undefined && stock === undefined) continue;

      if (isDryRun) {
        results.push({
          sku,
          status: "success",
          message: `[Simulación] ${targetCountry.name} -> Precio: ${price !== undefined ? `${price.toFixed(2)}€` : "-"} | Stock: ${stock !== undefined ? stock : "-"}`,
        });
      } else {
        try {
          const res = await fetch(`${API_URL}/api/listings/items/${encodeURIComponent(sku)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              price,
              stock,
              leadTimeDays: leadTime,
              marketplaceId: targetCountry.marketplaceId,
            }),
          });
          const resData = await res.json();
          if (res.ok) {
            results.push({
              sku,
              status: "success",
              message: `✅ Enviado a Amazon [${targetCountry.code}] (ID: ${resData.submissionId || "OK"})`,
            });
          } else {
            results.push({
              sku,
              status: "error",
              message: `❌ ${resData.error || (resData.errors && resData.errors[0]?.message) || "Error"}`,
            });
          }
        } catch (err) {
          results.push({
            sku,
            status: "error",
            message: `❌ ${err instanceof Error ? err.message : "Error red"}`,
          });
        }
      }
    }

    setCsvResults(results);
    setProcessingCsv(false);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      setCsvContent(event.target?.result as string);
    };
    reader.readAsText(file);
  };

  return (
    <main className="p-10 max-w-7xl mx-auto space-y-6">
      {/* Encabezado */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-lg">
              📦
            </span>
            <h1 className="text-2xl font-bold text-slate-100">Catálogo y Actualización de Precios/Stock</h1>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            {items.length.toLocaleString("es-ES")} productos. Actualiza precios y stock en directo por país (España, Francia, Italia, Alemania).
          </p>
        </div>

      </div>

      {loading && <p className="mt-6 text-slate-400">Cargando catálogo…</p>}
      {error && <p className="mt-6 text-red-400">Error: {error}</p>}

      {!loading && !error && (
        <>
          <div className="flex items-center justify-between gap-4">
            <input
              type="text"
              placeholder="Buscar por SKU, ASIN o título..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full sm:w-96 rounded-lg border border-slate-800 bg-slate-900 px-4 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
            <span className="text-xs text-slate-400">
              Mostrando {Math.min(filtered.length, 100)} de {filtered.length} productos
            </span>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/40">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-800 bg-slate-950/80 text-slate-400 uppercase tracking-wider">
                <tr>
                  <th className="py-3 px-4 font-semibold">SKU</th>
                  <th className="py-3 px-4 font-semibold">ASIN</th>
                  <th className="py-3 px-4 font-semibold">Título del Producto</th>
                  <th className="py-3 px-4 font-semibold text-center">Tipo</th>
                  <th className="py-3 px-4 font-semibold text-right">Precio Actual</th>
                  <th className="py-3 px-4 font-semibold text-right">Stock</th>
                  <th className="py-3 px-4 font-semibold text-center">Mercados</th>
                  <th className="py-3 px-4 font-semibold text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filtered.slice(0, 100).map((item) => {
                  const displaySku = maskSku(item.sku);
                  const displayAsin = maskAsin(item.asin);
                  const displayName = maskProductName(item.name, item.sku);

                  return (
                    <tr key={item.sku} className="hover:bg-slate-800/30 transition-colors">
                      <td className="py-3 px-4 font-mono font-semibold text-indigo-300">{displaySku}</td>
                      <td className="py-3 px-4 font-mono text-slate-400">
                        {item.asin ? (
                          isPrivacyMode ? (
                            <span>{displayAsin}</span>
                          ) : (
                            <a
                              href={`https://www.amazon.es/dp/${item.asin}`}
                              target="_blank"
                              rel="noreferrer"
                              className="hover:text-indigo-400 underline decoration-slate-700"
                            >
                              {displayAsin}
                            </a>
                          )
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="py-3 px-4 text-slate-200 max-w-sm truncate" title={displayName}>
                        {displayName}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold ${
                            (item as any).fulfillmentChannel === "FBA"
                              ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30"
                              : "bg-amber-500/15 text-amber-300 border border-amber-500/30"
                          }`}
                        >
                          {(item as any).fulfillmentChannel || "FBM"}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-medium text-slate-200 font-mono">
                        {(item as any).price ? `${(item as any).price.toFixed(2)} €` : "--"}
                      </td>
                      <td className="py-3 px-4 text-right font-medium text-slate-300 font-mono">
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-200">
                        {item.fulfillable} uds
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center">
                      <div className="flex items-center justify-center gap-1.5 text-sm" title="España, Francia, Italia, Alemania">
                        <span>🇪🇸</span>
                        <span>🇫🇷</span>
                        <span>🇮🇹</span>
                        <span>🇩🇪</span>
                      </div>
                    </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          onClick={() => handleOpenEdit(item)}
                          className="px-3 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 hover:text-indigo-200 border border-indigo-500/30 font-medium transition-all text-xs"
                        >
                          ✏️ Modificar
                        </button>
                      </td>
                    </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Modal de Edición Directa de Producto */}
      {editingItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  <span>⚡</span> Actualizar Oferta en Amazon
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">SKU: <strong className="text-indigo-300">{editingItem.sku}</strong></p>
              </div>
              <button
                onClick={() => setEditingItem(null)}
                className="text-slate-400 hover:text-slate-200 text-lg leading-none"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-300 line-clamp-2 bg-slate-950 p-2.5 rounded-lg border border-slate-800">
              {editingItem.name}
            </p>

            {saveSuccess && (
              <div className="p-3 rounded-lg bg-emerald-950/60 border border-emerald-800 text-emerald-300 text-xs flex items-center gap-2">
                <span>✅</span> {saveSuccess}
              </div>
            )}

            {saveError && (
              <div className="p-3 rounded-lg bg-rose-950/60 border border-rose-800 text-rose-300 text-xs">
                {saveError}
              </div>
            )}

            <div className="space-y-4">
              {/* Selector de País */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Seleccionar País / Marketplace:
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {COUNTRIES.map((c) => (
                    <button
                      key={c.code}
                      type="button"
                      onClick={() => setEditCountry(c.code)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                        editCountry === c.code
                          ? "border-indigo-500 bg-indigo-950/40 text-indigo-200 shadow-sm"
                          : "border-slate-800 bg-slate-950/50 text-slate-400 hover:border-slate-700"
                      }`}
                    >
                      <span>{c.flag}</span>
                      <span>{c.name}</span>
                      <span className="text-[10px] text-slate-500 font-mono ml-auto">({c.code})</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Nuevo Precio */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Nuevo Precio (€):
                </label>
                <input
                  type="text"
                  placeholder="Ej: 14.99 (dejar vacío si no cambia)"
                  value={editPrice}
                  onChange={(e) => setEditPrice(e.target.value)}
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
                />
                <span className="text-[10px] text-slate-500 mt-1 block">Aplica a FBA y FBM.</span>
              </div>

              {/* Stock FBM y Días de preparación */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Stock FBM (Almacén Propio):
                  </label>
                  <input
                    type="number"
                    placeholder="Ej: 50"
                    value={editStock}
                    onChange={(e) => setEditStock(e.target.value)}
                    className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Días Preparación (Lead Time):
                  </label>
                  <input
                    type="number"
                    value={editLeadTime}
                    onChange={(e) => setEditLeadTime(e.target.value)}
                    className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setEditingItem(null)}
                className="px-4 py-2 text-xs font-medium rounded-lg text-slate-400 hover:text-slate-200"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleSaveEdit}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-all disabled:opacity-50 flex items-center gap-2 shadow-sm"
              >
                {saving ? "Enviando a Amazon..." : "Enviar Cambio a Amazon SP-API"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Subida Masiva CSV por País */}
      {showCsvModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  <span>📄</span> Subida Masiva de Precios / Stock por País
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Sube un archivo CSV separado por punto y coma (;) o coma (,) para España, Francia, Italia o Alemania.
                </p>
              </div>
              <button
                onClick={() => setShowCsvModal(false)}
                className="text-slate-400 hover:text-slate-200 text-lg leading-none"
              >
                ✕
              </button>
            </div>

            {/* Selector de País Base */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Mercado / País Destino:
              </label>
              <div className="grid grid-cols-4 gap-2">
                {COUNTRIES.map((c) => (
                  <button
                    key={c.code}
                    type="button"
                    onClick={() => setCsvCountry(c.code)}
                    className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                      csvCountry === c.code
                        ? "border-emerald-500 bg-emerald-950/40 text-emerald-200 shadow-sm"
                        : "border-slate-800 bg-slate-950/50 text-slate-400 hover:border-slate-700"
                    }`}
                  >
                    <span>{c.flag}</span>
                    <span>{c.name}</span>
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 mt-1">
                * Si tu CSV ya contiene una columna llamada <code>pais</code> o <code>country</code> (ej: <code>FR</code>, <code>IT</code>), se usará la del archivo para cada fila.
              </p>
            </div>

            {/* Input archivo o texto */}
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-300">
                Selecciona archivo CSV o pega el contenido:
              </label>
              <input
                type="file"
                accept=".csv,.txt"
                onChange={handleFileUpload}
                className="block w-full text-xs text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-slate-800 file:text-slate-200 hover:file:bg-slate-700 cursor-pointer"
              />
              <textarea
                rows={6}
                value={csvContent}
                onChange={(e) => setCsvContent(e.target.value)}
                placeholder={"sku;precio;stock;lead_time_days\n27593SGFBA;12.50;;\n2676192CLM;28.90;50;2"}
                className="w-full rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isDryRun}
                  onChange={(e) => setIsDryRun(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-950 text-indigo-600 focus:ring-0"
                />
                <span>Modo Simulación (Dry-Run: verificar sin enviar a Amazon)</span>
              </label>
            </div>

            {/* Resultados */}
            {csvResults && (
              <div className="border border-slate-800 rounded-lg p-3 bg-slate-950/80 max-h-48 overflow-y-auto space-y-1.5 text-xs">
                <p className="font-semibold text-slate-300 mb-2">Resultados del proceso ({csvResults.length} filas):</p>
                {csvResults.map((r, i) => (
                  <div key={i} className="flex items-center justify-between gap-4 font-mono text-[11px]">
                    <span className="text-indigo-300">{r.sku}</span>
                    <span className={r.status === "success" ? "text-emerald-400" : "text-rose-400"}>
                      {r.message}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setShowCsvModal(false)}
                className="px-4 py-2 text-xs font-medium rounded-lg text-slate-400 hover:text-slate-200"
              >
                Cerrar
              </button>
              <button
                type="button"
                disabled={processingCsv || !csvContent.trim()}
                onClick={handleProcessCsv}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-all disabled:opacity-50 flex items-center gap-2 shadow-sm"
              >
                {processingCsv ? "Procesando con Amazon..." : isDryRun ? "Simular Cambios" : "Ejecutar Actualización en Amazon"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
