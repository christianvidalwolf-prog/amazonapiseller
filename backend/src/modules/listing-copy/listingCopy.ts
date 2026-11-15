import { aggregateWeeks, listingLeaks, normalizeTerm } from "../brand-analytics/funnelInsights";
import type { SearchQueryMetrics } from "../brand-analytics/searchFunnel.types";

/**
 * Autonomous title + bullets agent (spec advertising §16). Pure logic: which ASIN to rewrite, which
 * searches the copy must cover, the guardrails a proposal must pass, and the 28-day verdict that keeps
 * or reverts a change. Prices and images are never touched.
 */

export const BRAND = "ROCKING GIFTS";
export const MAX_PER_WEEK = 3;
export const COOLDOWN_DAYS = 28;
export const REVIEW_DAYS = 28;
export const REVERT_DROP = 0.15;
export const MIN_REVIEW_IMPRESSIONS = 300;
export const TITLE_MAX = 200;
export const BULLET_MAX = 500;
export const BULLETS = 5;
const DAY = 86_400_000;

/** Promotional / unverifiable claims Amazon forbids in titles and bullets (ES/DE/FR/IT/EN). */
const BANNED = [
  "oferta", "descuento", "rebaja", "gratis", "envío gratis", "mejor precio", "el mejor", "la mejor", "garantía de por vida", "100% garantizado",
  "angebot", "rabatt", "kostenlos", "gratis versand", "bester preis", "der beste", "die beste",
  "promo", "promotion", "soldes", "réduction", "livraison gratuite", "meilleur prix", "le meilleur", "la meilleure",
  "offerta", "sconto", "spedizione gratuita", "miglior prezzo", "il migliore", "la migliore",
  "best seller", "bestseller", "sale", "free shipping", "cheapest", "#1", "nº1", "n°1", "top seller",
];
const FORBIDDEN_CHARS = /[!$?_{}^¬¦~#<>*|]/;

export interface TermSignal {
  term: string;
  purchases: number;
  clicks: number;
  volume: number;
}

export interface Candidate {
  asin: string;
  reason: string;
  /** Searches that convert for this ASIN, best first — the copy must cover them. */
  terms: TermSignal[];
}

export interface Experiment {
  asin: string;
  sku: string;
  country: string;
  appliedAt: string;
  reason: string;
  before: { title: unknown[]; bullets: unknown[] };
  after: { title: string; bullets: string[] };
  status: "running" | "kept" | "reverted" | "overridden";
  verdict?: string;
}

export interface CopyState {
  experiments: Experiment[];
}

const ageDays = (iso: string, now: Date) => (now.getTime() - new Date(iso).getTime()) / DAY;

export function convertingTerms(rows: SearchQueryMetrics[], asin: string, top = 8): TermSignal[] {
  return aggregateWeeks(rows.filter((r) => r.asin === asin))
    .filter((m) => m.totalPurchases > 0 && m.asinImpressions > 0)
    .map((m) => ({ term: normalizeTerm(m.queryText), purchases: m.asinPurchases, clicks: m.asinClicks, volume: m.totalQueryVolume }))
    .sort((a, b) => b.purchases - a.purchases || b.volume - a.volume)
    .slice(0, top);
}

/** Converting searches whose words are not all in the current title + bullets. */
export function missingTerms(terms: TermSignal[], copy: string): TermSignal[] {
  const text = normalizeTerm(copy);
  return terms.filter((t) => t.term.split(" ").some((w) => w.length > 2 && !text.includes(w)));
}

/**
 * ASINs worth rewriting, most impressions first: a CTR or cart leak against the market (SQP), or a
 * converting search the copy does not mention. Skips ASINs outside the brand, with a running
 * experiment, or changed in the last COOLDOWN_DAYS.
 */
export function pickCandidates(
  rows: SearchQueryMetrics[],
  brandAsins: Set<string>,
  copyOf: Map<string, string>,
  state: CopyState,
  now: Date,
  limit: number
): Candidate[] {
  const busy = new Set(state.experiments.filter((e) => e.status === "running" || ageDays(e.appliedAt, now) < COOLDOWN_DAYS).map((e) => e.asin));
  const leaks = new Map(listingLeaks(rows).map((l) => [l.asin, l]));
  const impressions = new Map<string, number>();
  for (const r of rows) impressions.set(r.asin, (impressions.get(r.asin) ?? 0) + r.asinImpressions);
  const out: Candidate[] = [];
  for (const asin of [...brandAsins].sort((a, b) => (impressions.get(b) ?? 0) - (impressions.get(a) ?? 0))) {
    if (busy.has(asin) || !copyOf.has(asin)) continue;
    const terms = convertingTerms(rows, asin);
    if (!terms.length) continue;
    const leak = leaks.get(asin);
    const copyLeak = leak && !/precio/i.test(leak.action) ? `${leak.action} (${leak.why})` : "";
    const missing = missingTerms(terms, copyOf.get(asin) ?? "");
    if (!copyLeak && !missing.length) continue;
    out.push({ asin, terms, reason: copyLeak || `búsquedas que convierten y no están en el texto: ${missing.map((t) => t.term).join(", ")}` });
    if (out.length >= limit) break;
  }
  return out;
}

/** Guardrails a proposal must pass before it even reaches Amazon's validation. Empty = OK. */
export function checkCopy(title: string, bullets: string[], brand = BRAND): string[] {
  const errors: string[] = [];
  const all = [title, ...bullets];
  if (!title.trim()) errors.push("título vacío");
  if (title.length > TITLE_MAX) errors.push(`título de ${title.length} caracteres (máx ${TITLE_MAX})`);
  if (!title.toUpperCase().startsWith(brand.toUpperCase())) errors.push(`el título debe empezar por ${brand}`);
  if (bullets.length < 3 || bullets.length > BULLETS) errors.push(`${bullets.length} bullets (3–${BULLETS})`);
  bullets.forEach((b, i) => {
    if (!b.trim()) errors.push(`bullet ${i + 1} vacío`);
    if (b.length > BULLET_MAX) errors.push(`bullet ${i + 1} de ${b.length} caracteres (máx ${BULLET_MAX})`);
  });
  if (FORBIDDEN_CHARS.test(title)) errors.push("carácter no permitido en el título");
  for (const text of all) {
    const lower = ` ${text.toLowerCase()} `;
    const hit = BANNED.find((w) => new RegExp(`[^\\p{L}]${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\p{L}]`, "u").test(lower));
    if (hit) errors.push(`palabra promocional: "${hit}"`);
    if (/[€$£]\s?\d|\d\s?(€|eur\b)/i.test(text)) errors.push("menciona un precio");
  }
  const words = title.toLowerCase().match(/\p{L}{3,}/gu) ?? [];
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  const repeated = [...counts].filter(([, n]) => n > 2).map(([w]) => w);
  if (repeated.length) errors.push(`palabras repetidas más de 2 veces en el título: ${repeated.join(", ")}`);
  return [...new Set(errors)];
}

export interface FunnelRates {
  impressions: number;
  ctr: number;
  /** Purchases per impression — the whole funnel the copy influences. */
  conversion: number;
}

export function ratesFor(rows: SearchQueryMetrics[], asin: string, from: string, to: string): FunnelRates {
  const sel = rows.filter((r) => r.asin === asin && r.periodStart >= from && r.periodStart < to);
  const imp = sel.reduce((s, r) => s + r.asinImpressions, 0);
  const clk = sel.reduce((s, r) => s + r.asinClicks, 0);
  const buy = sel.reduce((s, r) => s + r.asinPurchases, 0);
  return { impressions: imp, ctr: imp ? clk / imp : 0, conversion: imp ? buy / imp : 0 };
}

export type Verdict = { action: "wait" } | { action: "keep" | "revert"; why: string };

/**
 * After REVIEW_DAYS compare the weeks since the change with the same span before it. Revert when
 * purchases per impression (or CTR, if there were no purchases before) fell more than REVERT_DROP.
 */
export function judge(rows: SearchQueryMetrics[], e: Experiment, now: Date): Verdict {
  if (ageDays(e.appliedAt, now) < REVIEW_DAYS) return { action: "wait" };
  const applied = e.appliedAt.slice(0, 10);
  const start = new Date(new Date(applied).getTime() - REVIEW_DAYS * DAY).toISOString().slice(0, 10);
  const end = new Date(new Date(applied).getTime() + REVIEW_DAYS * DAY).toISOString().slice(0, 10);
  const before = ratesFor(rows, e.asin, start, applied);
  const after = ratesFor(rows, e.asin, applied, end);
  if (after.impressions < MIN_REVIEW_IMPRESSIONS || before.impressions < MIN_REVIEW_IMPRESSIONS) {
    if (ageDays(e.appliedAt, now) < REVIEW_DAYS * 2) return { action: "wait" };
    return { action: "keep", why: `pocos datos (${before.impressions} → ${after.impressions} impresiones); se queda` };
  }
  const metric = before.conversion > 0 ? "conversion" : "ctr";
  const b = before[metric];
  const a = after[metric];
  const label = metric === "conversion" ? "compras/impresión" : "CTR";
  const why = `${label} ${(b * 100).toFixed(2)} % → ${(a * 100).toFixed(2)} %`;
  return b > 0 && a < b * (1 - REVERT_DROP) ? { action: "revert", why } : { action: "keep", why };
}

export function textOf(values: unknown): string[] {
  return Array.isArray(values) ? values.map((v) => String((v as { value?: unknown })?.value ?? "")).filter(Boolean) : [];
}
