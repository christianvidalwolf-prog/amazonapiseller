/**
 * Builds every dashboard payload by calling the backend's own Express routes
 * in-process, then upserts each one into the Supabase `snapshots` table.
 * The deployed (Vercel) frontend only ever reads those rows, never Amazon.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (+ the normal backend env).
 * Optional: ONLY=sales,inventory  → publish just keys starting with those prefixes.
 *           DRY_RUN=1             → build payloads but don't write to Supabase.
 */
import type { AddressInfo } from "node:net";
import http from "node:http";
import { publishPricingSnapshots } from "./lib/publish-pricing";
import { publishBsrSnapshots } from "./lib/publish-bsr";
import { BSR_MARKETPLACES } from "../src/modules/bsr/bsr.marketplaces";
import { salesDetailTargets } from "./lib/sales-detail-targets";
import { buildApp } from "../src/app";
import { env } from "../src/config/env";
import { EU_MARKETPLACES } from "../src/modules/account-health/account-health.service";
import { fetchNegativeFeedback } from "../src/modules/account-health/sellerFeedback";
import { SpApiClient } from "../src/spapi/client";

let rawUrl = (process.env.SUPABASE_URL ?? "").trim();
if (rawUrl && !rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) {
  rawUrl = `https://${rawUrl}`;
}
const SUPABASE_URL = rawUrl.replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const DRY_RUN = process.env.DRY_RUN === "1";
const ONLY = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function isoStartOfYear(): string {
  return new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)).toISOString();
}
function isoStartOfMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

const enc = encodeURIComponent;

/** One snapshot per month of the current year up to today, e.g. sales:month-2026-03. */
function monthlySalesTargets(): Array<[string, string]> {
  const now = new Date();
  const year = now.getUTCFullYear();
  const targets: Array<[string, string]> = [];
  for (let m = 0; m <= now.getUTCMonth(); m++) {
    const start = new Date(Date.UTC(year, m, 1)).toISOString();
    const end = new Date(Date.UTC(year, m + 1, 0, 23, 59, 59, 999)).toISOString();
    targets.push([`sales:month-${year}-${String(m + 1).padStart(2, "0")}`, `/api/sales/summary?start=${enc(start)}&end=${enc(end)}`]);
  }
  return targets;
}

const TARGETS: Array<[key: string, path: string]> = [
  ["inventory:snapshot", "/api/inventory/snapshot"],
  ["listings:list", "/api/listings"],
  ["sales:year", `/api/sales/summary?start=${enc(isoStartOfYear())}`],
  ["sales:this_month", `/api/sales/summary?start=${enc(isoStartOfMonth())}`],
  ["sales:last_30d", `/api/sales/summary?start=${enc(isoDaysAgo(30))}`],
  ...monthlySalesTargets(),
  ...salesDetailTargets(),
  ["finance:summary", "/api/finance/summary?refresh=true"],
  ["finance:annual", "/api/finance/annual?refresh=true"],
  ["finance:expenses", "/api/finance/expenses"],
  ["finance:reimbursements", "/api/finance/reimbursements?country=ALL"],
  ["finance:reimbursements:ES", "/api/finance/reimbursements?country=ES"],
  ["finance:reimbursements:DE", "/api/finance/reimbursements?country=DE"],
  ["finance:reimbursements:FR", "/api/finance/reimbursements?country=FR"],
  ["finance:reimbursements:IT", "/api/finance/reimbursements?country=IT"],
  ["finance:reimbursements:BE", "/api/finance/reimbursements?country=BE"],
  ["finance:reimbursements:NL", "/api/finance/reimbursements?country=NL"],
  ["finance:reimbursements:PL", "/api/finance/reimbursements?country=PL"],
  ["finance:reimbursements:SE", "/api/finance/reimbursements?country=SE"],
  ["margins:products", "/api/pricing/margins"],
  ["account-health:summary", "/api/account-health/summary?marketplaceId=EU&force=true"],
  ["account-health:summary:EU", "/api/account-health/summary?marketplaceId=EU"],
  ["account-health:summary:ES", "/api/account-health/summary?marketplaceId=ES"],
  ["account-health:summary:DE", "/api/account-health/summary?marketplaceId=DE"],
  ["account-health:summary:FR", "/api/account-health/summary?marketplaceId=FR"],
  ["account-health:summary:IT", "/api/account-health/summary?marketplaceId=IT"],
  ["account-health:summary:UK", "/api/account-health/summary?marketplaceId=UK"],
  ["account-health:summary:NL", "/api/account-health/summary?marketplaceId=NL"],
  ["account-health:summary:PL", "/api/account-health/summary?marketplaceId=PL"],
  ["account-health:summary:SE", "/api/account-health/summary?marketplaceId=SE"],
  ["account-health:summary:BE", "/api/account-health/summary?marketplaceId=BE"],
  ["advertising:summary", "/api/advertising/summary"],
  ["advertising:campaigns", "/api/advertising/campaigns"],
  ["brand-analytics:search-funnel:WEEK", "/api/brand-analytics/search-funnel?period=WEEK&refresh=true"],
  ["brand-analytics:search-funnel:MONTH", "/api/brand-analytics/search-funnel?period=MONTH&refresh=true"],
  // After MONTH on purpose: the month it just fetched is reused, only the two before are requested.
  ["brand-analytics:search-funnel:LAST_3_MONTHS", "/api/brand-analytics/search-funnel?period=LAST_3_MONTHS&refresh=true"],
];

function inspectSupabaseKey(key: string): void {
  try {
    const parts = key.split(".");
    if (parts.length === 3) {
      const pad = 4 - (parts[1].length % 4);
      const padded = parts[1] + (pad < 4 ? "=".repeat(pad) : "");
      const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
      if (payload.role === "anon") {
        console.warn(
          "\n⚠️  ATENCIÓN CONFIGURACIÓN: La variable SUPABASE_SERVICE_ROLE_KEY tiene el rol 'anon' (clave pública) en lugar de 'service_role'.\n" +
          "Esto provocará errores RLS (42501) al intentar escribir en Supabase.\n" +
          "Solución: Ve a Supabase → Project Settings → API, copia la clave secreta 'service_role' y actualiza el secreto SUPABASE_SERVICE_ROLE_KEY en GitHub Actions.\n"
        );
      } else if (payload.role === "service_role") {
        console.log(`[Supabase] Conectando con clave 'service_role' (válida)`);
      }
    }
  } catch {
    // Si no es un JWT estándar de Supabase, ignorar parseo
  }
}

// In-process requests go through node:http instead of fetch: undici's client
// enforces a 5-minute headers timeout that the full-catalog pricing build
// (limit=0) regularly exceeds, which would silently degrade the published
// snapshot to the limit=200 fallback.
interface LocalResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

function localFetch(url: string, timeoutMs: number): Promise<LocalResponse> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
          status: res.statusCode ?? 0,
          json: async () => JSON.parse(body) as unknown,
          text: async () => body,
        });
      });
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs}ms: ${url}`)));
    req.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Supabase's gateway occasionally returns transient 502/503/504 (or drops the
// connection) on individual upserts. Retrying is safe: the write is idempotent
// thanks to on_conflict=key.
const UPSERT_ATTEMPTS = 3;
const RETRYABLE_SUPABASE_STATUSES = new Set([429, 500, 502, 503, 504]);

async function upsert(key: string, data: unknown, attempt = 1): Promise<void> {
  const fullUrl = `${SUPABASE_URL}/rest/v1/snapshots?on_conflict=key`;
  let res: Response;
  try {
    res = await fetch(fullUrl, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY!,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
    });
  } catch (err) {
    if (attempt < UPSERT_ATTEMPTS) {
      console.warn(`Supabase upsert de '${key}' falló por red (intento ${attempt}/${UPSERT_ATTEMPTS}): ${err instanceof Error ? err.message : String(err)}. Reintentando...`);
      await sleep(attempt * 5_000);
      return upsert(key, data, attempt + 1);
    }
    throw new Error(`Supabase upsert failed (network error tras ${UPSERT_ATTEMPTS} intentos) en '${key}': ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const errorBody = await res.text();
    if (RETRYABLE_SUPABASE_STATUSES.has(res.status) && attempt < UPSERT_ATTEMPTS) {
      console.warn(`Supabase upsert de '${key}' devolvió ${res.status} (intento ${attempt}/${UPSERT_ATTEMPTS}). Reintentando...`);
      await sleep(attempt * 5_000);
      return upsert(key, data, attempt + 1);
    }
    if (res.status === 405) {
      throw new Error(
        `Supabase upsert failed (405 Method Not Allowed) en ${fullUrl}. ` +
        `Causa común: la tabla 'snapshots' no existe en el esquema público de Supabase o la URL de Supabase es incorrecta. ` +
        `Verifica haber ejecutado supabase/schema.sql en el SQL Editor de Supabase. Respuesta: ${errorBody}`
      );
    }
    if ((res.status === 401 || res.status === 403) && errorBody.includes("42501")) {
      throw new Error(
        `Supabase upsert failed (401/42501 RLS policy violation) en ${fullUrl}.\n` +
        `Causa: La tabla 'snapshots' tiene RLS activado pero la clave utilizada no tiene permisos de inserción/actualización (p. ej. se usó la clave 'anon' en vez de 'service_role').\n` +
        `SOLUCIÓN RÁPIDA: Ve a Supabase Dashboard → SQL Editor y ejecuta:\n` +
        `  CREATE POLICY "snapshots_allow_all" ON public.snapshots FOR ALL USING (true) WITH CHECK (true);\n` +
        `o bien desactiva RLS con:\n` +
        `  ALTER TABLE public.snapshots DISABLE ROW LEVEL SECURITY;\n` +
        `Y asegúrate de que el secreto SUPABASE_SERVICE_ROLE_KEY en GitHub contenga la clave 'service_role' (secreta) de Supabase.`
      );
    }
    throw new Error(`Supabase upsert failed (${res.status}) en '${key}': ${errorBody}`);
  }
}

async function main(): Promise<void> {
  if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_KEY)) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or set DRY_RUN=1)");
  }
  if (!DRY_RUN && SUPABASE_KEY) {
    inspectSupabaseKey(SUPABASE_KEY);
  }

  const server = buildApp().listen(0);
  server.timeout = 0; // Disable socket timeout for long-running batch snapshot generation
  server.keepAliveTimeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const fetchWithTimeout = (url: string, timeoutMs = 1_800_000) =>
    localFetch(url, timeoutMs);

  const targets = ONLY.length ? TARGETS.filter(([key]) => ONLY.some((p) => key.startsWith(p))) : TARGETS;
  let published = 0;
  const includeBsr = !ONLY.length || ONLY.some((prefix) => "bsr:catalog".startsWith(prefix) || "bsr:history".startsWith(prefix) || prefix.startsWith("bsr:"));
  let bsrFailed = false;
  let salesDetailsFailed = false;
  const includePricing = !ONLY.length || ONLY.some((prefix) => "pricing:summary".startsWith(prefix) || "pricing:offers".startsWith(prefix) || prefix.startsWith("pricing:"));
  let pricingFailed = false;
  if (includePricing) {
    try {
      const count = await publishPricingSnapshots(async (path) => {
        try {
          const res = await fetchWithTimeout(base + path);
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`${path} returned ${res.status}: ${body}`);
          }
          return res.json();
        } catch (fetchErr) {
          const cause = (fetchErr as { cause?: unknown })?.cause;
          const details = cause ? ` (cause: ${String(cause)})` : "";
          throw new Error(`${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}${details}`);
        }
      }, async (key, data) => {
        if (!DRY_RUN) await upsert(key, data);
      });
      published++;
      console.log(`ok   pricing (${count} snapshots)${DRY_RUN ? " [dry-run]" : ""}`);
    } catch (err) {
      pricingFailed = true;
      console.error(`FAIL pricing: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Publish BSR before the slower reports, including every selectable product.
  // El marketplace por defecto va primero con sus claves de siempre; luego cada país.
  if (includeBsr) {
    const extraMarketplaces = BSR_MARKETPLACES.filter((m) => m.id !== env.marketplaceIds[0]).map((m) => m.code);
    for (const marketplace of [undefined, ...extraMarketplaces]) {
      const label = marketplace ? `bsr ${marketplace}` : "bsr";
      try {
        const count = await publishBsrSnapshots(async (path) => {
          const res = await fetchWithTimeout(base + path);
          if (!res.ok) throw new Error(`${path} returned ${res.status}`);
          return res.json();
        }, async (key, data) => {
          if (!DRY_RUN) await upsert(key, data);
        }, marketplace);
        published += 1;
        console.log(`ok   ${label} (${count} snapshots)${DRY_RUN ? " [dry-run]" : ""}`);
      } catch (err) {
        bsrFailed = true;
        console.error(`FAIL ${label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  for (const [key, path] of targets) {
    try {
      const res = await fetchWithTimeout(base + path);
      if (!res.ok) throw new Error(`endpoint returned ${res.status}`);
      const data = await res.json();
      const bytes = JSON.stringify(data).length;
      if (!DRY_RUN) await upsert(key, data);
      published += 1;
      console.log(`ok   ${key} (${(bytes / 1024).toFixed(0)} KB)${DRY_RUN ? " [dry-run]" : ""}`);
    } catch (err) {
      // A failed target keeps its previous snapshot in Supabase instead of blanking the dashboard.
      if (key.startsWith("sales:details:")) salesDetailsFailed = true;
      console.error(`FAIL ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Customer feedback goes straight through the service (no HTTP hop): Amazon allows ~1 feedback report/min,
  // so the full run takes several minutes and would outlast any request timeout.
  let total = targets.length + (includeBsr ? 1 : 0) + (includePricing ? 1 : 0);

  if (!ONLY.length || ONLY.some((p) => "account-health:negatives".startsWith(p) || p.startsWith("account-health"))) {
    total += 1;
    try {
      const items = await fetchNegativeFeedback(new SpApiClient({ credentials: env.spApi }), Object.values(EU_MARKETPLACES), true);
      const byCode = (code: string) => items.filter((i) => i.marketplaceCode === code);
      const payloads: Array<[string, unknown]> = [
        ["account-health:negatives", items],
        ["account-health:negatives:EU", items],
        ...Object.keys(EU_MARKETPLACES).map((code): [string, unknown] => [`account-health:negatives:${code}`, byCode(code)]),
      ];
      if (!DRY_RUN) for (const [key, data] of payloads) await upsert(key, data);
      published += 1;
      console.log(`ok   account-health:negatives (${items.length} valoraciones negativas)${DRY_RUN ? " [dry-run]" : ""}`);
    } catch (err) {
      console.error(`FAIL account-health:negatives: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  server.close();
  console.log(`${published}/${total} snapshots published`);
  // If at least one snapshot was published and core sales/BSR didn't catastrophically fail,
  // don't fail the entire GitHub Actions runner if pricing had a transient network timeout
  // (previous snapshot remains intact in Supabase).
  process.exit(published === 0 || bsrFailed || salesDetailsFailed ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
