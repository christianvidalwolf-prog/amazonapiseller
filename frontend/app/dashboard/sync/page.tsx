"use client";

import { API_ORIGIN } from "@/lib/apiBase";
import { useEffect, useState, useRef } from "react";
import Link from "next/link";

interface SyncHistoryItem {
  id: string;
  startedAt: string;
  finishedAt: string;
  scope: string;
  status: "success" | "error";
  durationSeconds: number;
  details?: string;
}

interface SyncLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
}

interface SyncStatus {
  isSyncing: boolean;
  currentTask: string | null;
  startedAt: string | null;
  lastSyncAt: string | null;
  lastStatus: "success" | "error" | null;
  nextSyncAt: string | null;
  intervalMinutes: number;
  autoSyncEnabled: boolean;
  records: {
    inventorySkus: number;
    salesLines: number;
  };
  history: SyncHistoryItem[];
  logs: SyncLogEntry[];
}

const API_BASE = `${API_ORIGIN}/api/sync`;

export default function SyncDashboardPage() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logTerminalRef = useRef<HTMLDivElement>(null);

  const fetchStatus = async () => {
    try {
      const res = await fetch(`${API_BASE}/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: SyncStatus = await res.json();
      setStatus(data);
      setError(null);
    } catch (err) {
      setError("No se pudo conectar con el servicio de sincronización (Express en :4000).");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    // Polling adaptativo: cada 2.5s si está sincronizando, o cada 10s en reposo
    const interval = setInterval(() => {
      fetchStatus();
    }, status?.isSyncing ? 2500 : 8000);

    return () => clearInterval(interval);
  }, [status?.isSyncing]);

  // Auto scroll terminal al recibir nuevos logs
  useEffect(() => {
    if (logTerminalRef.current) {
      logTerminalRef.current.scrollTop = logTerminalRef.current.scrollHeight;
    }
  }, [status?.logs]);

  const handleTrigger = async (scope: "all" | "inventory" | "sales") => {
    setTriggering(scope);
    try {
      const res = await fetch(`${API_BASE}/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope }),
      });
      const data = await res.json();
      if (!res.ok && res.status !== 202) {
        alert(data.message || "Error al disparar sincronización");
      } else {
        await fetchStatus();
      }
    } catch (err) {
      alert("Error de conexión al disparar sincronización.");
    } finally {
      setTriggering(null);
    }
  };

  const handleUpdateConfig = async (intervalMinutes?: number, autoSyncEnabled?: boolean) => {
    try {
      const res = await fetch(`${API_BASE}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intervalMinutes, autoSyncEnabled }),
      });
      if (res.ok) {
        const updated = await res.json();
        setStatus(updated);
      }
    } catch {
      alert("Error al actualizar configuración del worker.");
    }
  };

  return (
    <main className="max-w-7xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-800 pb-6 mb-8">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Link href="/" className="text-xs text-slate-400 hover:text-slate-200">
              Inicio
            </Link>
            <span className="text-xs text-slate-600">/</span>
            <span className="text-xs text-emerald-400 font-medium">Sincronización en Segundo Plano</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-3">
            Automatización y Sincronización SP-API
            {status?.isSyncing ? (
              <span className="text-xs bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2.5 py-0.5 rounded-full flex items-center gap-1.5 animate-pulse">
                <span className="w-2 h-2 rounded-full bg-amber-400"></span>
                Sincronizando ({status.currentTask})
              </span>
            ) : status?.autoSyncEnabled ? (
              <span className="text-xs bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2.5 py-0.5 rounded-full flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                Worker Activo (Cada {status.intervalMinutes} min)
              </span>
            ) : (
              <span className="text-xs bg-slate-800 text-slate-400 border border-slate-700 px-2.5 py-0.5 rounded-full">
                Pausado
              </span>
            )}
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Mantiene el catálogo, inventario FBA y ventas de Amazon actualizados sin esperas ni bloqueos en la interfaz.
          </p>
        </div>

        {/* Acciones de Disparo Manual */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => handleTrigger("all")}
            disabled={status?.isSyncing || triggering !== null}
            className={`px-4 py-2 text-sm font-medium rounded-lg shadow transition-all flex items-center gap-2 ${
              status?.isSyncing
                ? "bg-slate-800 text-slate-500 cursor-not-allowed"
                : "bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-950"
            }`}
          >
            {status?.isSyncing ? (
              <>
                <svg className="animate-spin h-4 w-4 text-amber-400" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                </svg>
                Procesando...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Sincronizar Todo
              </>
            )}
          </button>

          <button
            onClick={() => handleTrigger("inventory")}
            disabled={status?.isSyncing || triggering !== null}
            className="px-3 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg transition-colors disabled:opacity-50"
          >
            Solo Inventario
          </button>

          <button
            onClick={() => handleTrigger("sales")}
            disabled={status?.isSyncing || triggering !== null}
            className="px-3 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg transition-colors disabled:opacity-50"
          >
            Solo Ventas (15d)
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 rounded-lg bg-rose-950/40 border border-rose-800/60 text-rose-300 text-sm">
          {error}
        </div>
      )}

      {/* Tarjetas KPI de Estado */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800">
          <p className="text-xs font-medium text-slate-400">Estado del Programador</p>
          <div className="flex items-center justify-between mt-2">
            <p className="text-lg font-bold text-slate-100">
              {status?.autoSyncEnabled ? "Automático (Activo)" : "Pausado"}
            </p>
            <button
              onClick={() => handleUpdateConfig(undefined, !status?.autoSyncEnabled)}
              className="text-xs text-cyan-400 hover:text-cyan-300 underline"
            >
              {status?.autoSyncEnabled ? "Pausar" : "Reanudar"}
            </button>
          </div>
          <div className="mt-3 pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
            <span>Frecuencia:</span>
            <select
              value={status?.intervalMinutes || 60}
              onChange={(e) => handleUpdateConfig(Number(e.target.value))}
              className="bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs text-slate-200"
            >
              <option value={15}>Cada 15 min</option>
              <option value={30}>Cada 30 min</option>
              <option value={60}>Cada 1 hora</option>
              <option value={120}>Cada 2 horas</option>
              <option value={360}>Cada 6 horas</option>
            </select>
          </div>
        </div>

        <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800">
          <p className="text-xs font-medium text-slate-400">Última Sincronización</p>
          <p className="text-lg font-bold text-slate-100 mt-2">
            {status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleTimeString("es-ES") : "Pendiente"}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            {status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleDateString("es-ES") : "Ninguna en esta sesión"}
          </p>
          <div className="mt-2 text-xs">
            {status?.lastStatus === "success" && (
              <span className="text-emerald-400 font-medium">✓ Última ejecución correcta</span>
            )}
            {status?.lastStatus === "error" && (
              <span className="text-rose-400 font-medium">⚠ Hubo errores en el último ciclo</span>
            )}
          </div>
        </div>

        <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800">
          <p className="text-xs font-medium text-slate-400">Próximo Ciclo Programado</p>
          <p className="text-lg font-bold text-slate-100 mt-2">
            {status?.nextSyncAt ? new Date(status.nextSyncAt).toLocaleTimeString("es-ES") : "--:--"}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            {status?.autoSyncEnabled ? "Se ejecutará automáticamente" : "Programador en pausa"}
          </p>
        </div>

        <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800">
          <p className="text-xs font-medium text-slate-400">Registros Indexados</p>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="text-xs text-slate-400">Inventario FBA:</span>
            <span className="text-sm font-semibold text-slate-100">
              {status?.records.inventorySkus.toLocaleString("es-ES") ?? 0} SKUs
            </span>
          </div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-xs text-slate-400">Ventas 2026:</span>
            <span className="text-sm font-semibold text-slate-100">
              {status?.records.salesLines.toLocaleString("es-ES") ?? 0} líneas
            </span>
          </div>
        </div>
      </div>

      {/* Consola de Logs en Directo */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-cyan-400"></span>
            Consola de Actividad del Worker en Vivo
          </h2>
          <button
            onClick={fetchStatus}
            className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refrescar
          </button>
        </div>

        <div
          ref={logTerminalRef}
          className="h-64 overflow-y-auto bg-slate-950 border border-slate-800 rounded-xl p-4 font-mono text-xs text-slate-300 space-y-1 shadow-inner"
        >
          {status?.logs && status.logs.length > 0 ? (
            status.logs.map((log, i) => (
              <div key={i} className="flex items-start gap-2 leading-relaxed">
                <span className="text-slate-500 shrink-0">[{log.timestamp}]</span>
                <span
                  className={`font-semibold shrink-0 ${
                    log.level === "error"
                      ? "text-rose-400"
                      : log.level === "warn"
                      ? "text-amber-400"
                      : "text-emerald-400"
                  }`}
                >
                  {log.level.toUpperCase()}
                </span>
                <span
                  className={`${
                    log.level === "error"
                      ? "text-rose-200"
                      : log.level === "warn"
                      ? "text-amber-200"
                      : "text-slate-300"
                  }`}
                >
                  {log.message}
                </span>
              </div>
            ))
          ) : (
            <p className="text-slate-500 italic">Esperando eventos de sincronización...</p>
          )}
        </div>
      </div>

      {/* Historial de Ejecuciones */}
      <div>
        <h2 className="text-sm font-semibold text-slate-200 mb-3">Historial de Ejecuciones Recientes</h2>
        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/40">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950/80 text-slate-400 uppercase tracking-wider border-b border-slate-800">
              <tr>
                <th className="px-4 py-3">Hora Inicio</th>
                <th className="px-4 py-3">Alcance</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Duración</th>
                <th className="px-4 py-3">Detalles</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {status?.history && status.history.length > 0 ? (
                status.history.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-800/30">
                    <td className="px-4 py-3 font-medium text-slate-200">
                      {new Date(item.startedAt).toLocaleString("es-ES")}
                    </td>
                    <td className="px-4 py-3 uppercase font-semibold text-cyan-400">{item.scope}</td>
                    <td className="px-4 py-3">
                      {item.status === "success" ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          Completado
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">
                          Error
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-400">{item.durationSeconds}s</td>
                    <td className="px-4 py-3 text-slate-400 truncate max-w-xs">{item.details || "--"}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                    No hay ejecuciones registradas en esta sesión. Pulsa "Sincronizar Todo" para ejecutar el primer ciclo.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
