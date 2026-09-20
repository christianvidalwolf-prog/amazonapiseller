import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface SyncLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface SyncHistoryItem {
  id: string;
  startedAt: string;
  finishedAt: string;
  scope: string;
  status: "success" | "error";
  durationSeconds: number;
  details?: string;
}

export interface SyncStatus {
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

export class SyncService {
  private isSyncing = false;
  private currentTask: string | null = null;
  private syncStartedAt: string | null = null;
  private lastSyncAt: string | null = null;
  private lastStatus: "success" | "error" | null = null;
  private intervalMinutes = 60;
  private autoSyncEnabled = true;
  private timer: NodeJS.Timeout | null = null;
  private nextSyncAt: string | null = null;

  private history: SyncHistoryItem[] = [];
  private logs: SyncLogEntry[] = [];

  constructor() {
    this.addLog("info", "SyncService inicializado. Programando worker automático.");
    this.scheduleNextRun();
  }

  public getStatus(): SyncStatus {
    return {
      isSyncing: this.isSyncing,
      currentTask: this.currentTask,
      startedAt: this.syncStartedAt,
      lastSyncAt: this.lastSyncAt,
      lastStatus: this.lastStatus,
      nextSyncAt: this.nextSyncAt,
      intervalMinutes: this.intervalMinutes,
      autoSyncEnabled: this.autoSyncEnabled,
      records: this.countRecords(),
      history: this.history.slice(0, 10),
      logs: this.logs.slice(-50),
    };
  }

  public setConfig(params: { intervalMinutes?: number; autoSyncEnabled?: boolean }) {
    if (typeof params.intervalMinutes === "number" && params.intervalMinutes >= 5) {
      this.intervalMinutes = params.intervalMinutes;
      this.addLog("info", `Intervalo de sincronización actualizado a cada ${this.intervalMinutes} minutos.`);
    }
    if (typeof params.autoSyncEnabled === "boolean") {
      this.autoSyncEnabled = params.autoSyncEnabled;
      this.addLog("info", `Sincronización automática ${this.autoSyncEnabled ? "ACTIVADA" : "PAUSADA"}.`);
    }
    this.scheduleNextRun();
    return this.getStatus();
  }

  public async triggerSync(scope: "all" | "inventory" | "sales" = "all"): Promise<{ started: boolean; message: string }> {
    if (this.isSyncing) {
      return {
        started: false,
        message: `Ya hay una sincronización en curso (${this.currentTask}). Por favor espera a que termine.`,
      };
    }

    // Ejecutar en segundo plano de manera asíncrona
    void this.executeSync(scope);

    return {
      started: true,
      message: `Sincronización (${scope}) iniciada en segundo plano.`,
    };
  }

  private scheduleNextRun() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (!this.autoSyncEnabled) {
      this.nextSyncAt = null;
      return;
    }

    const delayMs = this.intervalMinutes * 60 * 1000;
    const nextDate = new Date(Date.now() + delayMs);
    this.nextSyncAt = nextDate.toISOString();

    this.timer = setTimeout(() => {
      this.addLog("info", "Ejecutando ciclo automático de sincronización programada.");
      void this.executeSync("all").finally(() => {
        this.scheduleNextRun();
      });
    }, delayMs);
  }

  private async executeSync(scope: "all" | "inventory" | "sales"): Promise<void> {
    this.isSyncing = true;
    this.currentTask = `Sincronizando ${scope}`;
    const startTime = Date.now();
    this.syncStartedAt = new Date().toISOString();

    this.addLog("info", `🚀 Iniciando proceso de sincronización [${scope}]...`);

    // Ruta al script de sincronización
    const scriptPath = path.resolve(process.cwd(), "..", "sync_recent_data.py");
    const altScriptPath = path.resolve(process.cwd(), "sync_recent_data.py");
    const finalScriptPath = fs.existsSync(scriptPath) ? scriptPath : altScriptPath;

    try {
      await this.runPythonScript(finalScriptPath, [`--mode=${scope}`, "--days=15"]);
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);
      this.lastSyncAt = new Date().toISOString();
      this.lastStatus = "success";

      const historyItem: SyncHistoryItem = {
        id: `sync_${Date.now()}`,
        startedAt: this.syncStartedAt,
        finishedAt: this.lastSyncAt,
        scope,
        status: "success",
        durationSeconds,
        details: `Completado en ${durationSeconds}s sin errores.`,
      };
      this.history.unshift(historyItem);
      this.addLog("info", `✅ Sincronización [${scope}] completada exitosamente en ${durationSeconds} segundos.`);
    } catch (err: unknown) {
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);
      this.lastStatus = "error";
      const errMsg = err instanceof Error ? err.message : String(err);

      const historyItem: SyncHistoryItem = {
        id: `sync_${Date.now()}`,
        startedAt: this.syncStartedAt,
        finishedAt: new Date().toISOString(),
        scope,
        status: "error",
        durationSeconds,
        details: errMsg,
      };
      this.history.unshift(historyItem);
      this.addLog("error", `❌ Error durante la sincronización [${scope}]: ${errMsg}`);
    } finally {
      this.isSyncing = false;
      this.currentTask = null;
      this.syncStartedAt = null;
    }
  }

  private runPythonScript(scriptPath: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn("python3", [scriptPath, ...args], {
        cwd: path.dirname(scriptPath),
      });

      proc.stdout.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
          const lines = text.split("\n");
          for (const line of lines) {
            if (line.includes("urllib3") || line.includes("NotOpenSSLWarning")) continue;
            this.addLog("info", line);
          }
        }
      });

      proc.stderr.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (text && !text.includes("urllib3") && !text.includes("NotOpenSSLWarning")) {
          this.addLog("warn", text);
        }
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`El script de sincronización terminó con código de salida ${code}`));
        }
      });

      proc.on("error", (err) => {
        reject(err);
      });
    });
  }

  private addLog(level: "info" | "warn" | "error", message: string) {
    this.logs.push({
      timestamp: new Date().toLocaleTimeString("es-ES"),
      level,
      message,
    });
    if (this.logs.length > 200) {
      this.logs.shift();
    }
  }

  private countRecords(): { inventorySkus: number; salesLines: number } {
    let inventorySkus = 0;
    let salesLines = 0;

    const invPath = path.resolve(process.cwd(), "..", "inventario_fba.csv");
    const altInvPath = path.resolve(process.cwd(), "inventario_fba.csv");
    const targetInv = fs.existsSync(invPath) ? invPath : fs.existsSync(altInvPath) ? altInvPath : null;
    if (targetInv) {
      try {
        const lines = fs.readFileSync(targetInv, "utf-8").split(/\r?\n/).filter(Boolean);
        inventorySkus = Math.max(0, lines.length - 1);
      } catch {
        // ignore
      }
    }

    const salesPath = path.resolve(process.cwd(), "..", "ventas_2026.csv");
    const altSalesPath = path.resolve(process.cwd(), "ventas_2026.csv");
    const targetSales = fs.existsSync(salesPath) ? salesPath : fs.existsSync(altSalesPath) ? altSalesPath : null;
    if (targetSales) {
      try {
        const lines = fs.readFileSync(targetSales, "utf-8").split(/\r?\n/).filter(Boolean);
        salesLines = Math.max(0, lines.length - 1);
      } catch {
        // ignore
      }
    }

    return { inventorySkus, salesLines };
  }
}
