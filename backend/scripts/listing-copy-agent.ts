/**
 * Autonomous title + bullets agent (spec advertising §16). Only ROCKING GIFTS listings; never prices
 * or images. Daily, per country (ES/DE/FR/IT):
 *  1. Reviews experiments older than 28 days with Brand Analytics (SQP): purchases per impression
 *     down > 15 % → restores the saved original title/bullets. If Amazon or someone else changed the
 *     copy meanwhile, marks it "overridden" and leaves it.
 *  2. Picks up to 3 ASINs per country per week (28-day cooldown per ASIN) with a CTR/cart leak or
 *     converting searches missing from the copy, asks Claude Code (`claude -p`, the user's
 *     subscription) for a new title + bullets in the marketplace language, checks the guardrails,
 *     validates with Amazon (PATCH VALIDATION_PREVIEW) and applies.
 * State and backups: snapshot `listing-copy:state:<CC>` in data/ads-reports. LISTING_COPY_APPLY=0 only
 * proposes. Report: informes-ads/listing-copy-AAAA-MM-DD.txt.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { env } from "../src/config/env";
import { createFileAdsReportStore } from "../src/modules/advertising/adsReports.store";
import type { SearchQueryMetrics } from "../src/modules/brand-analytics/searchFunnel.types";
import { createSupabaseSearchQueryMetricsRepository } from "../src/modules/brand-analytics/searchFunnel.supabaseRepository";
import {
  BRAND, BULLETS, type Candidate, checkCopy, type CopyState, type Experiment, judge, MAX_PER_WEEK, pickCandidates, textOf, TITLE_MAX, BULLET_MAX,
} from "../src/modules/listing-copy/listingCopy";
import { SpApiClient } from "../src/spapi/client";
import { getListingsItem, patchListingsItem } from "../src/spapi/endpoints/listingsItems";
import { REPORTS_DIR } from "./lib/ads-proposals";

const COUNTRIES = (process.env.LISTING_COPY_COUNTRIES ?? "ES,DE,FR,IT").split(",").map((c) => c.trim().toUpperCase());
const MARKETPLACE: Record<string, string> = { ES: "A1RKKUPIHCS9HS", DE: "A1PA6795UKMFR9", FR: "A13V1IB3VIYZZH", IT: "APJ6JRA9NG5V4" };
const LANGUAGE: Record<string, string> = { ES: "español", DE: "alemán", FR: "francés", IT: "italiano" };
const APPLY = process.env.LISTING_COPY_APPLY !== "0";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const CATALOG = path.resolve(process.cwd(), "..", "catalogo_completo.csv");
const SQP_WEEKS = 12;
const now = new Date();
const today = now.toISOString().slice(0, 10);
const client = new SpApiClient({ credentials: env.spApi });
const store = createFileAdsReportStore(path.resolve(process.cwd(), "data", "ads-reports"));
const report: string[] = [];
const log = (line: string) => {
  console.log(line);
  report.push(line);
};

interface Live {
  sku: string;
  productType: string;
  title: unknown[];
  bullets: unknown[];
  languageTag: string;
}

function skusByAsin(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!fs.existsSync(CATALOG)) return out;
  const [head, ...lines] = fs.readFileSync(CATALOG, "utf8").replace(/^﻿/, "").split(/\r?\n/);
  const cols = head.split("\t");
  const iSku = cols.indexOf("seller-sku");
  const iAsin = cols.indexOf("asin1");
  for (const l of lines) {
    const c = l.split("\t");
    if (!c[iAsin] || !c[iSku]) continue;
    out.set(c[iAsin], [...(out.get(c[iAsin]) ?? []), c[iSku]]);
  }
  return out;
}

async function liveListing(sku: string, marketplaceId: string): Promise<Live | null> {
  try {
    const item = (await getListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [marketplaceId], includedData: ["summaries", "attributes"] })) as {
      summaries?: Array<{ productType?: string }>;
      attributes?: Record<string, unknown>;
    };
    const attrs = item.attributes ?? {};
    const brand = textOf(attrs.brand)[0] ?? "";
    if (brand.trim().toUpperCase() !== BRAND) return null;
    const title = (attrs.item_name as unknown[]) ?? [];
    const languageTag = String((title[0] as { language_tag?: string })?.language_tag ?? "");
    const productType = item.summaries?.[0]?.productType;
    if (!productType || !title.length || !languageTag) return null;
    return { sku, productType, title, bullets: (attrs.bullet_point as unknown[]) ?? [], languageTag };
  } catch {
    return null;
  }
}

function askClaude(country: string, c: Candidate, live: Live): { title: string; bullets: string[] } | null {
  const prompt = `Eres especialista en listings de Amazon. Reescribe el título y los bullets de este producto de la marca ${BRAND} en Amazon ${country}, en ${LANGUAGE[country]}.

Objetivo: más clics y más conversión en las búsquedas que ya venden. Motivo de este cambio: ${c.reason}.

Búsquedas que convierten para este ASIN (de más a menos compras), cúbrelas de forma natural, las más importantes al principio del título:
${c.terms.map((t) => `- "${t.term}" (${t.purchases} compras, ${t.clicks} clics, volumen ${t.volume})`).join("\n")}

Título actual: ${textOf(live.title)[0]}
Bullets actuales:
${textOf(live.bullets).map((b) => `- ${b}`).join("\n") || "(ninguno)"}

Reglas obligatorias:
- El título empieza exactamente por "${BRAND}", máximo ${TITLE_MAX} caracteres, sin repetir una palabra más de 2 veces, sin los caracteres ! $ ? _ { } ^ ¬ ¦ ~ # < > * |.
- Entre 3 y ${BULLETS} bullets, máximo ${BULLET_MAX} caracteres cada uno, cada uno empieza con una frase clave en mayúsculas seguida de ":".
- No inventes nada: usa solo datos (material, medidas, cantidad, uso, colores) que aparecen en el texto actual.
- Nada de precios, ofertas, descuentos, envío, "el mejor", "nº1", garantías ni afirmaciones que no se puedan comprobar.
- No cambies el tipo de producto ni la cantidad de unidades.

Responde SOLO con JSON: {"title": "...", "bullets": ["...", "..."]}`;
  try {
    const out = execFileSync(CLAUDE_BIN, ["-p", "--output-format", "json", "--model", "sonnet"], { input: prompt, encoding: "utf8", timeout: 180_000, maxBuffer: 10_000_000 });
    const text = String((JSON.parse(out) as { result?: string }).result ?? "");
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    const p = JSON.parse(json) as { title?: unknown; bullets?: unknown };
    if (typeof p.title !== "string" || !Array.isArray(p.bullets)) return null;
    return { title: p.title.trim(), bullets: p.bullets.map((b) => String(b).trim()).filter(Boolean) };
  } catch (err) {
    log(`  Claude no respondió: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    return null;
  }
}

const valueOf = (text: string, live: Live, marketplaceId: string) => ({ value: text, language_tag: live.languageTag, marketplace_id: marketplaceId });

async function patchCopy(live: Live, marketplaceId: string, title: unknown[], bullets: unknown[], preview: boolean): Promise<string[]> {
  const res = await patchListingsItem(
    client,
    { sellerId: env.sellerId, sku: live.sku, marketplaceIds: [marketplaceId] },
    {
      productType: live.productType,
      patches: [
        { op: "replace", path: "/attributes/item_name", value: title },
        { op: "replace", path: "/attributes/bullet_point", value: bullets },
      ],
    },
    preview ? { mode: "VALIDATION_PREVIEW" } : {}
  );
  return (res.issues ?? []).filter((i) => i.severity === "ERROR").map((i) => `${i.code}: ${i.message}`);
}

async function review(country: string, rows: SearchQueryMetrics[], state: CopyState): Promise<CopyState> {
  const marketplaceId = MARKETPLACE[country];
  const experiments: Experiment[] = [];
  for (const e of state.experiments) {
    if (e.status !== "running") {
      experiments.push(e);
      continue;
    }
    const verdict = judge(rows, e, now);
    if (verdict.action === "wait") {
      experiments.push(e);
      continue;
    }
    const live = await liveListing(e.sku, marketplaceId);
    if (!live || textOf(live.title)[0] !== e.after.title) {
      log(`  ${e.asin} ${e.sku}: el título ya no es el del agente (Amazon u otro proceso lo cambió) → overridden`);
      experiments.push({ ...e, status: "overridden", verdict: verdict.why });
      continue;
    }
    if (verdict.action === "revert") {
      const errors = APPLY ? await patchCopy(live, marketplaceId, e.before.title, e.before.bullets, false) : [];
      log(`  ${e.asin} ${e.sku}: ${verdict.why} → ${APPLY ? (errors.length ? `ERROR al revertir: ${errors.join("; ")}` : "REVERTIDO al texto original") : "revertiría (dry-run)"}`);
      experiments.push(APPLY && !errors.length ? { ...e, status: "reverted", verdict: verdict.why } : e);
    } else {
      log(`  ${e.asin} ${e.sku}: ${verdict.why} → se queda`);
      experiments.push({ ...e, status: "kept", verdict: verdict.why });
    }
  }
  return { experiments };
}

async function runCountry(country: string, rows: SearchQueryMetrics[], skus: Map<string, string[]>): Promise<void> {
  const marketplaceId = MARKETPLACE[country];
  const key = `listing-copy:state:${country}`;
  let state: CopyState = (await store.readSnapshot<CopyState>(key)) ?? { experiments: [] };
  log(`${country}: ${rows.length} filas SQP, ${state.experiments.filter((e) => e.status === "running").length} cambios en prueba`);
  state = await review(country, rows, state);

  const weekAgo = now.getTime() - 7 * 86_400_000;
  const budget = MAX_PER_WEEK - state.experiments.filter((e) => new Date(e.appliedAt).getTime() > weekAgo).length;
  if (budget <= 0) {
    log(`  cupo semanal (${MAX_PER_WEEK}) agotado`);
    await store.writeSnapshot(key, state);
    return;
  }
  const lives = new Map<string, Live>();
  for (const asin of [...new Set(rows.map((r) => r.asin))]) {
    for (const sku of skus.get(asin) ?? []) {
      const live = await liveListing(sku, marketplaceId);
      if (live) {
        lives.set(asin, live);
        break;
      }
    }
  }
  const copyOf = new Map([...lives].map(([asin, l]) => [asin, [...textOf(l.title), ...textOf(l.bullets)].join(" ")]));
  const candidates = pickCandidates(rows, new Set(lives.keys()), copyOf, state, now, budget);
  log(`  ${lives.size} ASINs de ${BRAND} con datos SQP · ${candidates.length} candidatos (cupo ${budget})`);

  for (const c of candidates) {
    const live = lives.get(c.asin) as Live;
    log(`  ${c.asin} ${live.sku}: ${c.reason}`);
    const proposal = askClaude(country, c, live);
    if (!proposal) continue;
    const problems = checkCopy(proposal.title, proposal.bullets);
    if (problems.length) {
      log(`    descartado: ${problems.join("; ")}`);
      continue;
    }
    const title = [valueOf(proposal.title, live, marketplaceId)];
    const bullets = proposal.bullets.map((b) => valueOf(b, live, marketplaceId));
    const previewErrors = await patchCopy(live, marketplaceId, title, bullets, true);
    if (previewErrors.length) {
      log(`    Amazon lo rechaza en la validación: ${previewErrors.join("; ")}`);
      continue;
    }
    log(`    antes: ${textOf(live.title)[0]}`);
    log(`    nuevo: ${proposal.title}`);
    proposal.bullets.forEach((b) => log(`      • ${b}`));
    if (!APPLY) {
      log("    (dry-run: no se publica)");
      continue;
    }
    const errors = await patchCopy(live, marketplaceId, title, bullets, false);
    if (errors.length) {
      log(`    ERROR al publicar: ${errors.join("; ")}`);
      continue;
    }
    log("    PUBLICADO · se revisa en 28 días");
    state = {
      experiments: [
        ...state.experiments,
        { asin: c.asin, sku: live.sku, country, appliedAt: now.toISOString(), reason: c.reason, before: { title: live.title, bullets: live.bullets }, after: proposal, status: "running" },
      ],
    };
  }
  await store.writeSnapshot(key, state);
}

async function main(): Promise<void> {
  if (!env.supabase.url || !env.supabase.serviceRoleKey) throw new Error("El agente de listings necesita Supabase (datos de Brand Analytics)");
  const repo = createSupabaseSearchQueryMetricsRepository(env.supabase.url, env.supabase.serviceRoleKey);
  const skus = skusByAsin();
  log(`AGENTE DE LISTINGS (título + bullets, ${BRAND}) · ${today} · ${APPLY ? "APLICA" : "dry-run"}`);
  for (const country of COUNTRIES) {
    try {
      const stored = await repo.latest(MARKETPLACE[country], "WEEK", SQP_WEEKS);
      await runCountry(country, stored?.metrics ?? [], skus);
    } catch (err) {
      log(`${country}: ERROR ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORTS_DIR, `listing-copy-${today}.txt`), `${report.join("\n")}\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
