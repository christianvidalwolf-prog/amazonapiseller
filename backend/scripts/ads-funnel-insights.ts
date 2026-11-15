/**
 * Fase C del embudo (spec advertising §15): análisis de Brand Analytics (Search Query Performance)
 * cruzado con Amazon Ads. Cada día guarda por país `ads_sqp-insights_<profileId>.json`, que el agente
 * del embudo (ads:funnel) usa como segunda señal (Fase D). Los viernes, o con ADS_INSIGHTS_PDF=1,
 * genera el informe semanal de recomendaciones: informes-ads/embudo-AAAA-MM-DD.pdf (+ .html).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AdsApiClient } from "../src/ads/adsClient";
import type { SearchTermReportRow } from "../src/ads/reportTypes";
import { env } from "../src/config/env";
import { createFileAdsReportStore } from "../src/modules/advertising/adsReports.store";
import { type AdsTermStats, buildInsights, confirmedCuts, normalizeTerm, type Recommendation, recommend, type TrendPoint, trends } from "../src/modules/brand-analytics/funnelInsights";
import { createSupabaseSearchQueryMetricsRepository } from "../src/modules/brand-analytics/searchFunnel.supabaseRepository";
import { PREFIX, REPORTS_DIR } from "./lib/ads-proposals";

const COUNTRIES = (process.env.ADS_PLAN_COUNTRIES ?? "ES,DE,FR,IT").split(",").map((c) => c.trim().toUpperCase());
const MARKETPLACE: Record<string, string> = { ES: "A1RKKUPIHCS9HS", DE: "A1PA6795UKMFR9", FR: "A13V1IB3VIYZZH", IT: "APJ6JRA9NG5V4" };
const WEEKS = 4;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MT_KEYWORD = "application/vnd.spKeyword.v3+json";
const today = new Date().toISOString().slice(0, 10);
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export interface CountryInsights {
  country: string;
  generatedAt: string;
  weeks: string[];
  rows: number;
  recommendations: Recommendation[];
  cuts: Recommendation[];
  trends: TrendPoint[];
}

type Writer = ReturnType<AdsApiClient["writer"]>;
async function exactKeywords(w: Writer, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  let nextToken: string | undefined;
  do {
    const res = await w.post<{ keywords?: Array<{ keywordText: string; matchType: string }>; nextToken?: string }>("/sp/keywords/list", MT_KEYWORD, {
      campaignIdFilter: { include: ids },
      stateFilter: { include: ["ENABLED", "PAUSED"] },
      maxResults: 1000,
      ...(nextToken ? { nextToken } : {}),
    });
    for (const k of res.keywords ?? []) if (k.matchType === "EXACT") out.add(normalizeTerm(k.keywordText));
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

async function main(): Promise<void> {
  if (!env.supabase.url || !env.supabase.serviceRoleKey) throw new Error("El análisis SQP requiere Supabase configurado (ahí se guardan los informes de Brand Analytics)");
  const repo = createSupabaseSearchQueryMetricsRepository(env.supabase.url, env.supabase.serviceRoleKey);
  const ads = new AdsApiClient(env.adsApi);
  const store = createFileAdsReportStore(path.resolve(process.cwd(), "data", "ads-reports"));
  const profiles = (await ads.getProfiles()).filter((p) => COUNTRIES.includes(p.countryCode));
  const all: CountryInsights[] = [];
  for (const p of profiles) {
    const cc = p.countryCode;
    const profileId = String(p.profileId);
    try {
      const stored = await repo.latest(MARKETPLACE[cc], "WEEK", WEEKS);
      const metrics = stored?.metrics ?? [];
      const campaigns = (await ads.listSponsoredProductsCampaigns(profileId)).filter((c) => c.name.startsWith(PREFIX));
      const ids = new Set(campaigns.map((c) => c.campaignId));
      const exact = await exactKeywords(ads.writer(profileId), [...ids]);
      const adsStats = new Map<string, AdsTermStats>();
      for (const r of (await store.load<SearchTermReportRow>(profileId, "searchTerms"))?.rows ?? []) {
        if (!ids.has(String(r.campaignId))) continue;
        const term = normalizeTerm(String(r.searchTerm ?? ""));
        const a = adsStats.get(term) ?? { spend: 0, sales: 0, clicks: 0, orders: 0, exactLive: exact.has(term) };
        adsStats.set(term, { ...a, spend: a.spend + num(r.cost), sales: a.sales + num(r.sales7d), clicks: a.clicks + num(r.clicks), orders: a.orders + num(r.purchases7d) });
      }
      for (const term of exact) if (!adsStats.has(term)) adsStats.set(term, { spend: 0, sales: 0, clicks: 0, orders: 0, exactLive: true });
      const insights = buildInsights(metrics, adsStats);
      const result: CountryInsights = {
        country: cc,
        generatedAt: new Date().toISOString(),
        weeks: [...new Set(metrics.map((m) => m.periodStart))].sort(),
        rows: metrics.length,
        recommendations: recommend(insights, metrics),
        cuts: confirmedCuts(metrics, adsStats),
        trends: trends(metrics),
      };
      await store.writeSnapshot(`ads:sqp-insights:${profileId}`, result);
      all.push(result);
      const count = (k: Recommendation["kind"]) => result.recommendations.filter((r) => r.kind === k).length;
      console.log(`${cc}: SQP ${result.rows} filas (${result.weeks.length} semanas) · escalar ${count("scale")} · listing ${count("listing")} · oportunidades ${count("opportunity")} · cortar ${result.cuts.length}`);
    } catch (err) {
      console.log(`${cc}: ERROR ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
  if (new Date().getDay() === 5 || process.env.ADS_INSIGHTS_PDF === "1") {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const htmlPath = path.join(REPORTS_DIR, `embudo-${today}.html`);
    fs.writeFileSync(htmlPath, render(all));
    const pdfPath = path.join(REPORTS_DIR, `embudo-${today}.pdf`);
    try {
      execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`], { stdio: "ignore", timeout: 120_000 });
    } catch {
      /* the HTML stays */
    }
    console.log(`INFORME_EMBUDO ${fs.existsSync(pdfPath) ? pdfPath : htmlPath}`);
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const pct = (n: number) => `${(n * 100).toFixed(1)} %`;

function table(title: string, intro: string, rows: Recommendation[], limit = 15): string {
  if (!rows.length) return `<h3>${title}</h3><p class="muted">Nada esta semana.</p>`;
  return `<h3>${title}</h3><p class="muted">${intro}</p><table><thead><tr><th>Búsqueda</th><th>ASIN</th><th>Qué hacer</th><th>Por qué</th></tr></thead><tbody>${rows
    .slice(0, limit)
    .map((r) => `<tr><td><b>${esc(r.term)}</b></td><td>${esc(r.asin)}</td><td>${esc(r.action)}</td><td>${esc(r.why)}</td></tr>`)
    .join("")}</tbody></table>${rows.length > limit ? `<p class="muted">… y ${rows.length - limit} más.</p>` : ""}`;
}

function render(countries: CountryInsights[]): string {
  const sections = countries
    .map((c) => {
      const by = (k: Recommendation["kind"]) => c.recommendations.filter((r) => r.kind === k);
      const trendRows = c.trends.length
        ? `<table><thead><tr><th>Búsqueda</th><th>ASIN</th><th>Cuota de compras antes</th><th>Última semana</th><th></th></tr></thead><tbody>${c.trends
            .map((t) => `<tr><td>${esc(t.term)}</td><td>${t.asin}</td><td>${pct(t.previousShare)}</td><td>${pct(t.lastShare)}</td><td>${t.lastShare > t.previousShare ? "▲ mejora" : t.lastShare < t.previousShare ? "▼ empeora" : "= igual"}</td></tr>`)
            .join("")}</tbody></table>`
        : `<p class="muted">Hace falta más de una semana de datos.</p>`;
      return `<section><h2>${c.country}</h2><p class="muted">${c.rows} filas de Search Query Performance · semanas: ${c.weeks.join(", ") || "—"}</p>
${table("1. Escalar en Ads", "Búsquedas donde conviertes igual o mejor que el mercado (incluye ventas orgánicas). El agente las sube solo: 2+ compras → EXACTA, 1 compra → FRASE, con negativa en origen.", by("scale"))}
${table("2. Optimizar el listing", "Dónde se pierde el tráfico en el embudo (impresión → clic → carrito → compra) frente al mercado en las mismas búsquedas. Primero por ASIN, luego búsquedas concretas.", by("listing"))}
${table("3. Oportunidades", "Búsquedas grandes donde ya vendes pero apenas apareces.", by("opportunity"))}
${table("4. Cortar", "Gasto en Ads sin ventas confirmado por SQP (clics sin compras). El agente pone la negativa solo.", c.cuts)}
<h3>5. Evolución</h3>${trendRows}</section>`;
    })
    .join("");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Embudo de búsqueda</title><style>
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--head:#f5f5f7}
body{background:var(--bg);color:var(--fg);font:13px/1.45 -apple-system,system-ui,sans-serif;margin:24px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;border-bottom:2px solid var(--line);padding-bottom:4px;margin-top:28px}h3{font-size:14px;margin:18px 0 4px}
.muted{color:var(--muted);margin:2px 0 8px}table{border-collapse:collapse;width:100%;margin-bottom:8px}
th,td{border-bottom:1px solid var(--line);padding:5px 6px;text-align:left;vertical-align:top}th{background:var(--head);font-weight:600}
section{page-break-before:always}section:first-of-type{page-break-before:auto}
</style></head><body><h1>Embudo de búsqueda · Brand Analytics × Ads</h1><p class="muted">${today} · últimas ${WEEKS} semanas de Search Query Performance cruzadas con los términos de búsqueda de las campañas PF</p>${sections}</body></html>`;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
