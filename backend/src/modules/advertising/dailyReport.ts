import { LIMIT_ACOS, LOW_BAND_ACOS, TARGET_ACOS } from "./regulator";

/**
 * Daily report for the user (spec advertising §12), rendered as a printable HTML page that the daily
 * control turns into a PDF: summary with status per country, ACoS trend chart against the 25 % limit,
 * one section per country (KPIs, profit chart, what was detected, what was done and why) and the
 * proposals that need the user's decision with how to approve or reject them.
 * Pure: the daily control gathers the facts, this writes them. Colors follow the validated reference
 * palette (categorical slots 1-4 for ES/DE/FR/IT, blue/red diverging for profit, reserved status hues).
 */

export interface Money {
  spend: number;
  sales: number;
  acos: number | null;
}

export interface PendingProposal {
  code: string;
  action: string;
  text: string;
  reason: string;
}

export interface CountryDaily {
  country: string;
  window: { start: string; end: string } | null;
  transition: boolean;
  all: Money;
  pf: Money;
  baselineAcos: number | null;
  budget: number;
  guard: { paused: Array<{ sku: string; reason: string }>; resumed: string[] };
  regulator: { status: "learning" | "waiting" | "ran"; until?: string; countryAcos?: number | null; mode?: string; changes: Array<{ label: string; oldBid: number; newBid: number; reason: string }> };
  profit?: { profitAfterAds: number; leakSkus: number; leakLoss: number; winners: Array<{ sku: string; profit: number }>; leaks: Array<{ sku: string; profit: number }> };
  deadCampaigns: string[];
  decisions: Array<{ code: string; verdict: "approved" | "rejected"; result: string }>;
  pending: PendingProposal[];
  errors: string[];
}

export interface HistoryPoint {
  date: string;
  acos: Record<string, number | null>;
}

const COUNTRY_COLOR: Record<string, string> = { ES: "#2a78d6", DE: "#eb6834", FR: "#1baf7a", IT: "#eda100" };
const STATUS = {
  good: { color: "#0ca30c", text: "#006300", icon: "✓", label: "En objetivo" },
  warning: { color: "#fab219", text: "#8a5a00", icon: "!", label: "Vigilar" },
  critical: { color: "#d03b3b", text: "#b02a2a", icon: "✕", label: "Por encima del 25 %" },
  none: { color: "#898781", text: "#52514e", icon: "○", label: "Sin datos aún" },
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const eur = (n: number) => `${n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n.toLocaleString("es-ES", { maximumFractionDigits: 1 })} %`);

export function judgedAcos(c: CountryDaily): number | null {
  return c.transition ? c.pf.acos : c.all.acos;
}

const statusOf = (acos: number | null) => (acos === null ? STATUS.none : acos > LIMIT_ACOS ? STATUS.critical : acos > TARGET_ACOS ? STATUS.warning : STATUS.good);
const chip = (acos: number | null) => {
  const s = statusOf(acos);
  return `<span class="chip" style="--c:${s.color};--t:${s.text}"><b>${s.icon}</b> ${s.label}</span>`;
};

/** One-line verdict per country for the general summary. */
export function countryConclusion(c: CountryDaily): string {
  const acos = judgedAcos(c);
  const scope = c.transition ? "campañas nuevas" : "país";
  const status =
    acos === null
      ? "aún sin ventas atribuidas a las campañas nuevas (Amazon tarda ~3 días en dar datos y hasta 7 en atribuir ventas)"
      : acos > LIMIT_ACOS
        ? `ACoS ${scope} ${pct(acos)}: por encima del límite del ${LIMIT_ACOS} %`
        : acos > TARGET_ACOS
          ? `ACoS ${scope} ${pct(acos)}: dentro del límite pero por encima del objetivo del ${TARGET_ACOS} %`
          : `ACoS ${scope} ${pct(acos)}: dentro del objetivo`;
  const extras = [
    c.guard.paused.length ? `${c.guard.paused.length} anuncio(s) pausado(s) por stock/Buy Box` : "",
    c.regulator.changes.length ? `${c.regulator.changes.length} puja(s) ajustada(s)` : "",
    c.pending.length ? `${c.pending.length} propuesta(s) esperando tu decisión` : "",
    c.errors.length ? `${c.errors.length} error(es)` : "",
  ].filter(Boolean);
  return `${status}${extras.length ? `; ${extras.join("; ")}` : ""}.`;
}

/** ACoS trend per country with the 22 % target and 25 % limit; direct labels at line ends. */
function trendChart(history: HistoryPoint[], countries: string[]): string {
  const points = history.filter((h) => countries.some((c) => h.acos[c] !== null && h.acos[c] !== undefined));
  if (points.length < 2) {
    return `<div class="empty">La evolución del ACoS aparecerá aquí en cuanto haya al menos dos días con datos de las campañas nuevas.</div>`;
  }
  const W = 700;
  const H = 230;
  const L = 40;
  const R = 78;
  const T = 14;
  const B = 28;
  const max = Math.max(30, ...points.flatMap((p) => countries.map((c) => p.acos[c] ?? 0))) + 2;
  const x = (i: number) => L + (i * (W - L - R)) / (points.length - 1);
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const grid = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50]
    .filter((v) => v <= max)
    .map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 3}" class="tick" text-anchor="end">${v} %</text>`)
    .join("");
  const ref = (v: number, cls: string, label: string) =>
    `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="${cls}"/><text x="${L + 6}" y="${y(v) - 4}" class="reflabel ${cls}">${label}</text>`;
  const step = Math.max(1, Math.ceil(points.length / 8));
  const xTicks = points.map((p, i) => (i % step === 0 || i === points.length - 1 ? `<text x="${x(i)}" y="${H - 8}" class="tick" text-anchor="middle">${p.date.slice(5)}</text>` : "")).join("");
  const lines = countries.flatMap((c) => {
    const segs = points.flatMap((p, i) => (p.acos[c] === null || p.acos[c] === undefined ? [] : [[x(i), y(p.acos[c] as number), p.acos[c] as number] as const]));
    return segs.length ? [{ c, segs, last: segs[segs.length - 1] }] : [];
  });
  // End labels sorted top to bottom and pushed apart so close values never overlap.
  const labelY = lines
    .map((l) => ({ c: l.c, want: l.last[1] + 4 }))
    .sort((a, b) => a.want - b.want)
    .reduce<Array<{ c: string; y: number }>>((acc, l) => [...acc, { c: l.c, y: acc.length ? Math.max(l.want, acc[acc.length - 1].y + 13) : l.want }], []);
  const series = lines
    .map(({ c, segs, last }) => {
      const d = segs.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
      const ly = labelY.find((l) => l.c === c)?.y ?? last[1];
      return `<path d="${d}" fill="none" stroke="${COUNTRY_COLOR[c]}" stroke-width="2" stroke-linejoin="round"/>
        <circle cx="${last[0]}" cy="${last[1]}" r="4" fill="${COUNTRY_COLOR[c]}" stroke="#fcfcfb" stroke-width="2"/>
        <text x="${last[0] + 9}" y="${ly}" class="direct">${c} ${pct(last[2])}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Evolución del ACoS de 30 días por país">${grid}${ref(LIMIT_ACOS, "limit", "Límite 25 %")}${ref(TARGET_ACOS, "target", "Objetivo 22 %")}${xTicks}${series}</svg>
    <div class="legend">${countries.map((c) => `<span><i style="background:${COUNTRY_COLOR[c]}"></i>${c}</span>`).join("")}</div>`;
}

/** Profit after ads of the best and worst products: blue gains, red losses, values labelled. */
function profitChart(p: NonNullable<CountryDaily["profit"]>): string {
  const rows = [...p.winners, ...p.leaks].sort((a, b) => b.profit - a.profit);
  if (!rows.length) return "";
  const max = Math.max(...rows.map((r) => Math.abs(r.profit)), 1);
  const W = 700;
  const label = 130;
  const half = (W - label - 70) / 2;
  const zero = label + half;
  const rowH = 22;
  const bars = rows
    .map((r, i) => {
      const w = Math.max(2, (Math.abs(r.profit) / max) * half);
      const yy = 6 + i * rowH;
      const pos = r.profit >= 0;
      const bx = pos ? zero : zero - w;
      return `<text x="${label - 8}" y="${yy + 12}" class="tick" text-anchor="end">${esc(r.sku)}</text>
        <rect x="${bx}" y="${yy + 2}" width="${w}" height="14" rx="4" fill="${pos ? "#2a78d6" : "#e34948"}"/>
        <text x="${pos ? bx + w + 6 : bx - 6}" y="${yy + 13}" class="value" text-anchor="${pos ? "start" : "end"}">${pos ? "+" : ""}${eur(r.profit)}</text>`;
    })
    .join("");
  const H = 12 + rows.length * rowH;
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Beneficio tras publicidad por producto"><line x1="${zero}" x2="${zero}" y1="0" y2="${H}" class="axis"/>${bars}</svg>`;
}

function kpi(label: string, value: string, sub = ""): string {
  return `<div class="kpi"><div class="kpi-l">${label}</div><div class="kpi-v">${value}</div>${sub ? `<div class="kpi-s">${sub}</div>` : ""}</div>`;
}

function countrySection(c: CountryDaily): string {
  const acos = judgedAcos(c);
  const detected: string[] = [];
  if (c.profit) {
    detected.push(`Beneficio tras publicidad de las campañas nuevas: <b>${eur(c.profit.profitAfterAds)}</b> (${c.profit.leakSkus} producto(s) con pérdidas por ${eur(Math.abs(c.profit.leakLoss))}).`);
    if (c.profit.leaks.length) detected.push("Los productos que pierden dinero recibirán una bajada de puja del regulador si siguen así al terminar el aprendizaje.");
  }
  if (c.deadCampaigns.length) detected.push(`Campañas activas sin ninguna impresión: ${c.deadCampaigns.map(esc).join(", ")}. Suele ser puja demasiado baja o productos no elegibles; lo vigilo.`);
  if (acos !== null && acos > TARGET_ACOS) detected.push(`ACoS por encima del objetivo del ${TARGET_ACOS} %: ${c.regulator.status === "learning" ? `el regulador empezará a corregirlo el ${c.regulator.until}` : "el regulador lo está corrigiendo"}.`);
  if (acos !== null && acos < LOW_BAND_ACOS) detected.push(`ACoS holgado (&lt; ${LOW_BAND_ACOS} %): hay margen para dar más visibilidad a los ganadores.`);
  if (c.transition) detected.push("La ventana de 30 días aún incluye días anteriores al lanzamiento; mientras tanto juzgo solo las campañas nuevas.");

  const actions: Array<{ type: string; cls: string; what: string; why: string }> = [];
  for (const p of c.guard.paused) actions.push({ type: "Pausa", cls: "t-pause", what: `Anuncio de <b>${esc(p.sku)}</b>`, why: `${esc(p.reason)}: anunciar algo que no se puede comprar es pagar clics que no convierten. Se reactivará solo.` });
  for (const r of c.guard.resumed) actions.push({ type: "Reactivación", cls: "t-resume", what: `Anuncio de <b>${esc(r)}</b>`, why: "Vuelve a tener stock y Buy Box." });
  for (const ch of c.regulator.changes)
    actions.push({ type: ch.newBid < ch.oldBid ? "Puja ↓" : "Puja ↑", cls: ch.newBid < ch.oldBid ? "t-down" : "t-up", what: `${esc(ch.label)}: ${eur(ch.oldBid)} → <b>${eur(ch.newBid)}</b>`, why: esc(ch.reason) });
  for (const d of c.decisions)
    actions.push({ type: d.verdict === "approved" ? "Tu SÍ" : "Tu NO", cls: d.verdict === "approved" ? "t-up" : "t-pause", what: `<code>${d.code}</code>`, why: esc(d.result) });
  const regulatorNote =
    c.regulator.status === "learning"
      ? `No he tocado pujas: fase de aprendizaje hasta el <b>${c.regulator.until}</b> (Amazon necesita ~14 días de datos para juzgar con fiabilidad).`
      : c.regulator.status === "waiting"
        ? "No tocaba ajustar pujas hoy: el regulador actúa como máximo una vez cada 7 días para que cada cambio se pueda medir."
        : !c.regulator.changes.length
          ? `Regulador: ACoS ${pct(c.regulator.countryAcos)}, ${c.regulator.mode === "hold" ? "dentro de la banda 18-22 %, sin cambios" : "sin cambios necesarios"}.`
          : "";

  return `<section class="country" style="--cc:${COUNTRY_COLOR[c.country] ?? "#52514e"}">
    <header><h2><i></i>${c.country}</h2>${chip(acos)}</header>
    <div class="kpis">
      ${kpi("ACoS 30 días", pct(acos), c.transition ? "campañas nuevas" : "país completo")}
      ${kpi("Gasto", eur(c.transition ? c.pf.spend : c.all.spend), c.window ? `${c.window.start} → ${c.window.end}` : "sin informe")}
      ${kpi("Ventas publicidad", eur(c.transition ? c.pf.sales : c.all.sales))}
      ${kpi("Antes del lanzamiento", pct(c.baselineAcos), "ACoS 30 días")}
      ${kpi("Presupuesto activo", `${eur(c.budget)}/día`)}
    </div>
    ${c.profit && (c.profit.winners.length || c.profit.leaks.length) ? `<h3>Beneficio tras publicidad por producto</h3>${profitChart(c.profit)}` : ""}
    <h3>Qué he detectado</h3>
    <ul>${(detected.length ? detected : ["Nada relevante hoy."]).map((d) => `<li>${d}</li>`).join("")}</ul>
    <h3>Qué he hecho y por qué</h3>
    ${actions.length ? `<table><thead><tr><th>Acción</th><th>Sobre</th><th>Por qué</th></tr></thead><tbody>${actions.map((a) => `<tr><td><span class="tag ${a.cls}">${a.type}</span></td><td>${a.what}</td><td>${a.why}</td></tr>`).join("")}</tbody></table>` : ""}
    ${regulatorNote ? `<p class="note">${regulatorNote}</p>` : ""}
    <h3>Pendiente de tu aprobación</h3>
    ${
      c.pending.length
        ? `<table class="pending"><thead><tr><th>Código</th><th>Qué haría</th><th>Término / ASIN</th><th>Por qué</th></tr></thead><tbody>${c.pending
            .map((p) => `<tr><td><code>${p.code}</code></td><td>${esc(p.action)}</td><td>${esc(p.text)}</td><td>${esc(p.reason)}</td></tr>`)
            .join("")}</tbody></table>`
        : `<p class="note">Nada pendiente.</p>`
    }
    ${c.errors.length ? `<div class="errors"><b>Errores:</b><ul>${c.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
  </section>`;
}

const CSS = `
@page { size: A4; margin: 14mm 12mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #0b0b0b; background: #fcfcfb; font-size: 11px; line-height: 1.45; }
.cover { background: linear-gradient(135deg, #0d366b, #2a78d6); color: #fff; border-radius: 14px; padding: 22px 26px; margin-bottom: 16px; }
.cover h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: -0.01em; }
.cover p { margin: 0; opacity: 0.9; }
.cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 14px; }
.card { background: #fff; border: 1px solid #e1e0d9; border-top: 4px solid var(--cc); border-radius: 10px; padding: 10px 12px; }
.card .cc { font-weight: 700; font-size: 13px; }
.card .big { font-size: 22px; font-weight: 700; margin: 4px 0; }
.card p { margin: 6px 0 0; color: #52514e; font-size: 10px; }
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 600; color: var(--t); background: color-mix(in srgb, var(--c) 14%, #fff); border: 1px solid color-mix(in srgb, var(--c) 45%, #fff); }
.panel { background: #fff; border: 1px solid #e1e0d9; border-radius: 10px; padding: 12px 14px; margin-bottom: 14px; }
.panel h2, .country h3 { font-size: 12px; margin: 12px 0 6px; color: #0b0b0b; }
.panel h2 { margin-top: 0; }
.chart { width: 100%; height: auto; display: block; }
.grid { stroke: #e1e0d9; stroke-width: 1; }
.axis { stroke: #c3c2b7; stroke-width: 1; }
.tick { fill: #898781; font-size: 10px; font-variant-numeric: tabular-nums; }
.value { fill: #52514e; font-size: 10px; font-variant-numeric: tabular-nums; }
.direct { fill: #0b0b0b; font-size: 10px; font-weight: 700; }
.limit { stroke: #d03b3b; stroke-width: 1.5; stroke-dasharray: 5 4; fill: #b02a2a; }
.target { stroke: #898781; stroke-width: 1.5; stroke-dasharray: 2 4; fill: #52514e; }
.reflabel { font-size: 9px; stroke: #fcfcfb; stroke-width: 3px; paint-order: stroke; }
.legend { display: flex; gap: 14px; margin-top: 4px; color: #52514e; font-size: 10px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
.empty { padding: 18px; text-align: center; color: #898781; background: #f9f9f7; border-radius: 8px; }
.country { break-before: page; background: #fff; border: 1px solid #e1e0d9; border-radius: 12px; padding: 14px 16px; }
.country header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e1e0d9; padding-bottom: 8px; }
.country h2 { margin: 0; font-size: 18px; }
.country h2 i { display: inline-block; width: 12px; height: 12px; border-radius: 4px; background: var(--cc); margin-right: 8px; }
.kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-top: 10px; }
.kpi { background: #f9f9f7; border-radius: 8px; padding: 8px 10px; }
.kpi-l { color: #52514e; font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; }
.kpi-v { font-size: 15px; font-weight: 700; margin-top: 2px; }
.kpi-s { color: #898781; font-size: 9px; }
ul { margin: 0; padding-left: 16px; }
li { margin: 2px 0; }
table { width: 100%; border-collapse: separate; border-spacing: 0; margin-top: 4px; font-size: 10px; }
th { text-align: left; background: #f0efec; color: #52514e; font-weight: 600; padding: 6px 8px; }
th:first-child { border-radius: 6px 0 0 6px; } th:last-child { border-radius: 0 6px 6px 0; }
td { padding: 6px 8px; border-bottom: 1px solid #f0efec; vertical-align: top; }
tr { break-inside: avoid; }
.pending td:first-child code, td code { background: #e6effb; color: #0d366b; padding: 1px 5px; border-radius: 4px; font-weight: 700; }
.tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-weight: 600; font-size: 9px; white-space: nowrap; }
.t-pause { background: #fbe4e4; color: #b02a2a; } .t-resume, .t-up { background: #e2f3e2; color: #006300; } .t-down { background: #fdf0d9; color: #8a5a00; }
.note { color: #52514e; background: #f9f9f7; border-left: 3px solid #c3c2b7; padding: 6px 10px; border-radius: 0 6px 6px 0; margin: 6px 0; }
.howto { background: #e6effb; border: 1px solid #b7d3f6; border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; }
.howto pre { background: #fff; border-radius: 6px; padding: 6px 10px; margin: 6px 0; }
.errors { margin-top: 8px; color: #b02a2a; }
.foot { color: #898781; font-size: 9px; margin-top: 10px; }
`;

export function renderDailyReport(date: string, countries: CountryDaily[], history: HistoryPoint[], decisionsFile: string, invalidLines: string[], simulation = false): string {
  const pending = countries.flatMap((c) => c.pending);
  const cards = countries
    .map((c) => {
      const acos = judgedAcos(c);
      return `<div class="card" style="--cc:${COUNTRY_COLOR[c.country] ?? "#52514e"}"><div class="cc">${c.country}</div><div class="big">${pct(acos)}</div>${chip(acos)}<p>${esc(countryConclusion(c))}</p></div>`;
    })
    .join("");
  const latest = history.at(-1);
  const valueTable = latest
    ? `<table><thead><tr><th>Último dato (${latest.date})</th>${countries.map((c) => `<th>${c.country}</th>`).join("")}</tr></thead><tbody><tr><td>ACoS 30 días</td>${countries.map((c) => `<td>${pct(latest.acos[c.country])}</td>`).join("")}</tr><tr><td>Antes del lanzamiento</td>${countries.map((c) => `<td>${pct(c.baselineAcos)}</td>`).join("")}</tr></tbody></table>`
    : "";
  const howto = pending.length
    ? `<div class="howto"><b>Tienes ${pending.length} propuesta(s) pendiente(s).</b> Para decidir, abre <code>${esc(decisionsFile)}</code> y añade una línea por propuesta con su código y SI o NO:
       <pre>${pending.slice(0, 2).map((p, i) => `${p.code} ${i === 0 ? "SI" : "NO"}`).join("\n")}</pre>
       Se aplica en Amazon en la próxima ejecución (9:00). Para aplicarlo al momento: <code>cd backend &amp;&amp; npm run ads:decide -- &lt;código&gt; si</code>. Lo que no decidas sigue apareciendo mientras sea válido.</div>`
    : "";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe Amazon Ads ${date}</title><style>${CSS}</style></head><body>
    <div class="cover"><h1>Informe diario Amazon Ads</h1><p>${date} · Campañas profit-first en ES, DE, FR e IT · Objetivo: ACoS de cada país en 30 días ≤ ${LIMIT_ACOS} % (el sistema apunta al ${TARGET_ACOS} %)</p></div>
    ${simulation ? `<div class="howto"><b>Simulación:</b> esta ejecución no ha cambiado nada en Amazon; las acciones indican lo que se habría hecho.</div>` : ""}
    <div class="cards">${cards}</div>
    ${howto}
    ${invalidLines.length ? `<div class="errors">Líneas no entendidas en el fichero de decisiones: ${invalidLines.map((l) => `<code>${esc(l)}</code>`).join(", ")}</div>` : ""}
    <div class="panel"><h2>Evolución del ACoS de 30 días</h2>${trendChart(history, countries.map((c) => c.country))}${valueTable}</div>
    ${countries.map(countrySection).join("")}
    <p class="foot">Datos de Amazon Ads con ~3 días de retraso. Beneficio tras publicidad = unidades del propio producto × margen (neto de IVA, comisiones, coste y devoluciones) − gasto. Generado automáticamente por el control diario.</p>
  </body></html>`;
}
