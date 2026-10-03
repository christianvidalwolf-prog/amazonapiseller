"use client";

import { useEffect, useState } from "react";
import { API_ORIGIN } from "@/lib/apiBase";

interface ClaimItem {
  id: string;
  category: "WAREHOUSE_DAMAGED" | "CARRIER_DAMAGED" | "CUSTOMER_RETURN_MISSING" | "SWITCHEROO";
  categoryLabel: string;
  orderId: string;
  sku: string;
  asin: string;
  productName: string;
  salesChannel: string;
  countryCode: string;
  eventDate: string;
  fnsku: string;
  lpn: string;
  disposition: string;
  reason: string;
  estimatedAmount: number;
  currency: string;
  status: "PENDING_CLAIM" | "REIMBURSED" | "EXPIRED";
  daysPending: number;
  caseTemplate: string;
}

interface ReimbursementRecord {
  approvalDate: string;
  reimbursementId: string;
  caseId: string;
  amazonOrderId: string;
  reason: string;
  sku: string;
  fnsku: string;
  asin: string;
  productName: string;
  condition: string;
  currencyUnit: string;
  amountPerUnit: number;
  amountTotal: number;
  quantityTotal: number;
}

interface AuditSummary {
  updatedAt: string;
  totalPendingAmount: number;
  totalPendingClaims: number;
  totalHistoricalReimbursed: number;
  totalHistoricalRecords: number;
  availableMarketplaces: Array<{ code: string; name: string; count: number; totalAmount: number }>;
  claimsByCategory: Array<{ category: string; label: string; count: number; totalAmount: number }>;
  claims: ClaimItem[];
  recentReimbursements: ReimbursementRecord[];
}

const COUNTRY_OPTIONS = [
  { code: "ALL", name: "Todos los países (Europa)", flag: "🇪🇺" },
  { code: "ES", name: "España", flag: "🇪🇸" },
  { code: "DE", name: "Alemania", flag: "🇩🇪" },
  { code: "FR", name: "Francia", flag: "🇫🇷" },
  { code: "IT", name: "Italia", flag: "🇮🇹" },
  { code: "BE", name: "Bélgica", flag: "🇧🇪" },
  { code: "NL", name: "Países Bajos", flag: "🇳🇱" },
  { code: "PL", name: "Polonia", flag: "🇵🇱" },
  { code: "SE", name: "Suecia", flag: "🇸🇪" },
];

const money = (val: number, cur = "EUR") =>
  val.toLocaleString("es-ES", { style: "currency", currency: cur });

export default function ReimbursementsPage() {
  const [data, setData] = useState<AuditSummary | null>(null);
  const [selectedCountry, setSelectedCountry] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("ALL");
  const [selectedClaim, setSelectedClaim] = useState<ClaimItem | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"CLAIMS" | "HISTORY">("CLAIMS");

  const loadData = async (country: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = `${API_ORIGIN}/api/finance/reimbursements?country=${encodeURIComponent(country)}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Error HTTP ${res.status}: ${res.statusText}`);
      }
      const json: AuditSummary = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData(selectedCountry);
  }, [selectedCountry]);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2500);
  };

  const filteredClaims = (data?.claims || []).filter((c) => {
    if (categoryFilter !== "ALL" && c.category !== categoryFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        c.orderId.toLowerCase().includes(q) ||
        c.sku.toLowerCase().includes(q) ||
        c.asin.toLowerCase().includes(q) ||
        c.productName.toLowerCase().includes(q) ||
        (c.lpn && c.lpn.toLowerCase().includes(q))
      );
    }
    return true;
  });

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* HEADER */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 font-mono text-sm font-semibold">
              FBA RECOVERY
            </span>
            <h1 className="text-xl sm:text-2xl font-bold text-slate-100">
              Auditoría de Reclamaciones e Indemnizaciones FBA
            </h1>
          </div>
          <p className="text-sm text-slate-400 mt-1">
            Monitoreo continuo de mercancía dañada por Amazon en almacén, roturas en transporte y devoluciones sin reembolsar.
          </p>
        </div>

        {/* COUNTRY SELECTOR PILLS */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 max-w-full">
          {COUNTRY_OPTIONS.map((c) => {
            const isSelected = selectedCountry === c.code;
            return (
              <button
                key={c.code}
                onClick={() => setSelectedCountry(c.code)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 shrink-0 ${
                  isSelected
                    ? "bg-amber-400/20 text-amber-300 ring-1 ring-amber-400/50 shadow-sm"
                    : "bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-800/80 border border-slate-800"
                }`}
              >
                <span>{c.flag}</span>
                <span>{c.code === "ALL" ? "Todos" : c.code}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ERROR NOTICE */}
      {error && (
        <div className="p-4 rounded-xl bg-red-950/40 border border-red-800/50 text-red-300 text-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-lg">⚠️</span>
            <span>{error}</span>
          </div>
          <button
            onClick={() => loadData(selectedCountry)}
            className="px-3 py-1 bg-red-900/60 hover:bg-red-800/80 text-red-200 text-xs rounded-md transition"
          >
            Reintentar
          </button>
        </div>
      )}

      {/* METRIC SUMMARY CARDS */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 rounded-2xl bg-gradient-to-br from-slate-900 to-slate-950 border border-emerald-500/30 shadow-lg">
          <div className="flex items-center justify-between text-xs text-slate-400 font-medium">
            <span>DINERO PENDIENTE ESTIMADO</span>
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
          </div>
          <div className="mt-2 text-3xl font-extrabold text-emerald-400">
            {data ? money(data.totalPendingAmount) : "..."}
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {data?.totalPendingClaims || 0} incidencias pendientes de abrir caso
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-gradient-to-br from-slate-900 to-slate-950 border border-slate-800">
          <div className="text-xs text-slate-400 font-medium">DAÑADO EN ALMACÉN (FC)</div>
          <div className="mt-2 text-2xl font-bold text-amber-300">
            {data?.claimsByCategory.find((c) => c.category === "WAREHOUSE_DAMAGED")
              ? money(data.claimsByCategory.find((c) => c.category === "WAREHOUSE_DAMAGED")!.totalAmount)
              : "0,00 €"}
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {data?.claimsByCategory.find((c) => c.category === "WAREHOUSE_DAMAGED")?.count || 0} unidades rotas por operarios
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-gradient-to-br from-slate-900 to-slate-950 border border-slate-800">
          <div className="text-xs text-slate-400 font-medium">ROTURAS TRANSPORTE FBA</div>
          <div className="mt-2 text-2xl font-bold text-sky-300">
            {data?.claimsByCategory.find((c) => c.category === "CARRIER_DAMAGED")
              ? money(data.claimsByCategory.find((c) => c.category === "CARRIER_DAMAGED")!.totalAmount)
              : "0,00 €"}
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {data?.claimsByCategory.find((c) => c.category === "CARRIER_DAMAGED")?.count || 0} paquetes dañados por transportista
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-gradient-to-br from-slate-900 to-slate-950 border border-slate-800">
          <div className="text-xs text-slate-400 font-medium">HISTÓRICO REEMBOLSADO</div>
          <div className="mt-2 text-2xl font-bold text-slate-200">
            {data ? money(data.totalHistoricalReimbursed) : "..."}
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {data?.totalHistoricalRecords || 0} pagos abonados por Amazon
          </div>
        </div>
      </div>

      {/* COUNTRY DISTRIBUTION BAR */}
      {data && data.availableMarketplaces.length > 0 && selectedCountry === "ALL" && (
        <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800/80">
          <div className="text-xs font-semibold text-slate-300 mb-3 flex items-center justify-between">
            <span>DISTRIBUCIÓN DE RECLAMACIONES POR PAÍS</span>
            <span className="text-slate-500 font-normal">Haz clic en un país para filtrar</span>
          </div>
          <div className="flex flex-wrap gap-3">
            {data.availableMarketplaces.map((m) => (
              <button
                key={m.code}
                onClick={() => setSelectedCountry(m.code)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-950/70 border border-slate-800 hover:border-amber-400/50 transition-all text-left"
              >
                <span className="font-semibold text-slate-200 text-xs">{m.name}</span>
                <span className="text-xs text-slate-400">({m.count})</span>
                <span className="text-xs font-bold text-emerald-400 ml-1">{money(m.totalAmount)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* TABS: PENDING CLAIMS VS HISTORICAL REIMBURSEMENTS */}
      <div className="flex items-center justify-between gap-4 border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab("CLAIMS")}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition ${
              activeTab === "CLAIMS"
                ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/50"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
            }`}
          >
            Discrepancias y Casos a Reclamar ({filteredClaims.length})
          </button>
          <button
            onClick={() => setActiveTab("HISTORY")}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition ${
              activeTab === "HISTORY"
                ? "bg-amber-400/20 text-amber-300 ring-1 ring-amber-400/50"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
            }`}
          >
            Historial de Reembolsos Cobrados ({data?.recentReimbursements.length || 0})
          </button>
        </div>

        {activeTab === "CLAIMS" && (
          <div className="flex items-center gap-2 text-xs">
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="bg-slate-900 border border-slate-800 text-slate-300 rounded-lg px-3 py-1.5 text-xs focus:ring-1 focus:ring-emerald-400"
            >
              <option value="ALL">Todas las categorías</option>
              <option value="WAREHOUSE_DAMAGED">Dañado en Almacén</option>
              <option value="CARRIER_DAMAGED">Dañado en Transporte</option>
              <option value="SWITCHEROO">Cambiazo / Fraude</option>
            </select>
            <input
              type="text"
              placeholder="Buscar pedido, SKU, ASIN..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-slate-900 border border-slate-800 text-slate-300 rounded-lg px-3 py-1.5 text-xs focus:ring-1 focus:ring-emerald-400 w-48 sm:w-64"
            />
          </div>
        )}
      </div>

      {/* CLAIMS TABLE */}
      {activeTab === "CLAIMS" && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden shadow-xl">
          {loading ? (
            <div className="p-12 text-center text-slate-400 text-sm flex flex-col items-center justify-center gap-3">
              <div className="w-8 h-8 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin"></div>
              <span>Analizando reportes de indemnizaciones y devoluciones de Amazon...</span>
            </div>
          ) : filteredClaims.length === 0 ? (
            <div className="p-12 text-center text-slate-400 text-sm">
              No hay reclamaciones pendientes identificadas con los filtros actuales.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-300 border-collapse">
                <thead className="bg-slate-950/80 text-slate-400 font-semibold border-b border-slate-800">
                  <tr>
                    <th className="p-3.5">PEDIDO / FECHA</th>
                    <th className="p-3.5">PRODUCTO / SKU</th>
                    <th className="p-3.5">CANAL / PAÍS</th>
                    <th className="p-3.5">MOTIVO DISCREPANCIA</th>
                    <th className="p-3.5 text-right">IMPORTE ESTIMADO</th>
                    <th className="p-3.5 text-center">ANTIGÜEDAD</th>
                    <th className="p-3.5 text-center">ACCIÓN</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                  {filteredClaims.map((claim) => (
                    <tr key={claim.id} className="hover:bg-slate-800/40 transition">
                      <td className="p-3.5 whitespace-nowrap">
                        <div className="font-bold text-slate-100 flex items-center gap-1.5">
                          <span>{claim.orderId}</span>
                          <button
                            onClick={() => copyToClipboard(claim.orderId, claim.orderId)}
                            className="text-slate-500 hover:text-slate-300 transition"
                            title="Copiar ID de Pedido"
                          >
                            {copiedId === claim.orderId ? "✓" : "📋"}
                          </button>
                        </div>
                        <div className="text-[10px] text-slate-500 font-sans mt-0.5">
                          {claim.eventDate ? new Date(claim.eventDate).toLocaleDateString("es-ES") : "Reciente"}
                        </div>
                      </td>

                      <td className="p-3.5 font-sans">
                        <div className="font-medium text-slate-200 truncate max-w-xs" title={claim.productName}>
                          {claim.productName}
                        </div>
                        <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                          SKU: <strong className="text-amber-400/90">{claim.sku}</strong> | ASIN: {claim.asin}
                          {claim.lpn ? ` | LPN: ${claim.lpn}` : ""}
                        </div>
                      </td>

                      <td className="p-3.5 font-sans whitespace-nowrap">
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px] font-medium">
                          {claim.salesChannel}
                        </span>
                      </td>

                      <td className="p-3.5 font-sans">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${
                            claim.category === "WAREHOUSE_DAMAGED"
                              ? "bg-amber-950/60 text-amber-300 border border-amber-800/60"
                              : claim.category === "CARRIER_DAMAGED"
                              ? "bg-sky-950/60 text-sky-300 border border-sky-800/60"
                              : "bg-rose-950/60 text-rose-300 border border-rose-800/60"
                          }`}
                        >
                          {claim.categoryLabel}
                        </span>
                        <div className="text-[10px] text-slate-500 mt-0.5">
                          {claim.reason} {claim.disposition ? `(${claim.disposition})` : ""}
                        </div>
                      </td>

                      <td className="p-3.5 text-right font-bold text-emerald-400 text-xs whitespace-nowrap">
                        {money(claim.estimatedAmount, claim.currency)}
                      </td>

                      <td className="p-3.5 text-center font-sans whitespace-nowrap">
                        <span className="text-slate-400 text-xs font-medium">
                          {claim.daysPending} días
                        </span>
                      </td>

                      <td className="p-3.5 text-center font-sans whitespace-nowrap">
                        <button
                          onClick={() => setSelectedClaim(claim)}
                          className="px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-[11px] shadow-sm transition"
                        >
                          Abrir Caso ✉️
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* HISTORICAL REIMBURSEMENTS TABLE */}
      {activeTab === "HISTORY" && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden shadow-xl">
          <div className="p-4 border-b border-slate-800 text-xs text-slate-400 flex justify-between items-center">
            <span>Últimas 100 indemnizaciones abonadas automáticamente en tu saldo de Amazon</span>
            <span className="text-emerald-400 font-semibold">
              Total acumulado: {data ? money(data.totalHistoricalReimbursed) : "..."}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300 border-collapse">
              <thead className="bg-slate-950/80 text-slate-400 font-semibold border-b border-slate-800">
                <tr>
                  <th className="p-3.5">FECHA APROBACIÓN</th>
                  <th className="p-3.5">ID REEMBOLSO</th>
                  <th className="p-3.5">PEDIDO / CASO</th>
                  <th className="p-3.5">MOTIVO OFICIAL</th>
                  <th className="p-3.5">SKU / ASIN</th>
                  <th className="p-3.5 text-center">UNIDADES</th>
                  <th className="p-3.5 text-right">TOTAL PAGADO</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                {(data?.recentReimbursements || []).map((r, i) => (
                  <tr key={`${r.reimbursementId}-${i}`} className="hover:bg-slate-800/40 transition">
                    <td className="p-3.5 text-slate-400 whitespace-nowrap font-sans">
                      {new Date(r.approvalDate).toLocaleDateString("es-ES")}
                    </td>
                    <td className="p-3.5 text-slate-200 font-bold">{r.reimbursementId}</td>
                    <td className="p-3.5 text-slate-300 font-sans">
                      {r.amazonOrderId || r.caseId || "(Gestión FBA)"}
                    </td>
                    <td className="p-3.5 font-sans">
                      <span className="px-2 py-0.5 rounded bg-slate-800 text-amber-300 text-[10px] font-semibold">
                        {r.reason}
                      </span>
                    </td>
                    <td className="p-3.5">
                      <div className="text-slate-200">{r.sku}</div>
                      <div className="text-[10px] text-slate-500 font-sans">{r.asin}</div>
                    </td>
                    <td className="p-3.5 text-center">{r.quantityTotal}</td>
                    <td className="p-3.5 text-right font-bold text-emerald-400">
                      {money(r.amountTotal, r.currencyUnit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* CASE TEMPLATE MODAL */}
      {selectedClaim && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                <span>✉️ Plantilla de Caso para Seller Central</span>
              </h3>
              <button
                onClick={() => setSelectedClaim(null)}
                className="text-slate-400 hover:text-slate-200 text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs space-y-1">
              <div><strong>Pedido:</strong> {selectedClaim.orderId}</div>
              <div><strong>SKU:</strong> {selectedClaim.sku} | <strong>ASIN:</strong> {selectedClaim.asin}</div>
              <div><strong>Motivo:</strong> {selectedClaim.categoryLabel} ({selectedClaim.reason})</div>
              <div><strong>Importe a reclamar:</strong> <span className="text-emerald-400 font-bold">{money(selectedClaim.estimatedAmount, selectedClaim.currency)}</span></div>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                Texto para copiar y pegar en Ayuda &gt; Abrir un caso &gt; Reclamaciones FBA:
              </label>
              <textarea
                readOnly
                rows={9}
                value={selectedClaim.caseTemplate}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3.5 text-xs text-slate-200 font-sans focus:outline-none"
              />
            </div>

            <div className="flex justify-between items-center pt-2">
              <span className="text-[11px] text-slate-400">
                Pega este mensaje en Amazon Seller Central para solicitar el abono en 24-48h.
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setSelectedClaim(null)}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition"
                >
                  Cerrar
                </button>
                <button
                  onClick={() => copyToClipboard(selectedClaim.caseTemplate, "modal-copy")}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition flex items-center gap-1.5 shadow"
                >
                  <span>{copiedId === "modal-copy" ? "✓ Copiado al portapapeles" : "📋 Copiar Plantilla"}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
