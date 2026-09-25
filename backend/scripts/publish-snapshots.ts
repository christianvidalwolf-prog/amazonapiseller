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
];

async function upsert(key: string, data: unknown): Promise<void> {
  const fullUrl = `${SUPABASE_URL}/rest/v1/snapshots?on_conflict=key`;
  const res = await fetch(fullUrl, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY!,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const errorBody = await res.text();
    if (res.status === 405) {
      throw new Error(
        `Supabase upsert failed (405 Method Not Allowed) en ${fullUrl}. ` +
        `Causa común: la tabla 'snapshots' no existe en el esquema público de Supabase o la URL de Supabase es incorrecta. ` +
        `Verifica haber ejecutado supabase/schema.sql en el SQL Editor de Supabase. Respuesta: ${errorBody}`
      );
    }
    throw new Error(`Supabase upsert failed (${res.status}): ${errorBody}`);
  }
}

async function main(): Promise<void> {
  if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_KEY)) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or set DRY_RUN=1)");
  }

  const server = buildApp().listen(0);
  server.timeout = 0; // Disable socket timeout for long-running batch snapshot generation
  server.keepAliveTimeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const fetchWithTimeout = (url: string, timeoutMs = 1_800_000) =>
    fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

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
