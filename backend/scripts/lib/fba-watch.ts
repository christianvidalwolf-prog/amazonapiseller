/**
 * Vigilante FBA: listings con stock vendible en almacenes de Amazon que no están a la venta (no BUYABLE).
 * Lógica pura (sin SP-API): clasificar un listing y montar el email de aviso.
 */

export interface ListingIssue {
  code: string;
  message: string;
  severity: string;
}

export interface InactiveListing {
  sku: string;
  pais: string;
  asin: string | null;
  unidades: number;
  estado: string[];
  motivos: string[];
}

/** Motivos de un listing no comprable: sus issues de severidad ERROR, o el estado si Amazon no da ninguno. */
export function inactiveReasons(status: string[], issues: ListingIssue[]): string[] | null {
  if (status.includes("BUYABLE")) return null;
  const errors = issues.filter((i) => i.severity === "ERROR").map((i) => `${i.code}: ${i.message}`);
  if (errors.length) return [...new Set(errors)];
  return [status.length ? `Estado ${status.join(", ")} sin errores informados` : "Sin estado en Amazon (oferta no creada o sin precio)"];
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function alertSubject(rows: InactiveListing[]): string {
  const countries = [...new Set(rows.map((r) => r.pais))].join(", ");
  return `FBA: ${rows.length} listing${rows.length === 1 ? "" : "s"} inactivo${rows.length === 1 ? "" : "s"} con stock (${countries})`;
}

export function alertHtml(rows: InactiveListing[], date: string): string {
  const sorted = [...rows].sort((a, b) => b.unidades - a.unidades || a.sku.localeCompare(b.sku) || a.pais.localeCompare(b.pais));
  const cell = "padding:6px 8px;border-bottom:1px solid #ddd;vertical-align:top";
  const body = sorted
    .map((r) => {
      const asin = r.asin ? `<a href="https://www.amazon.${r.pais === "ES" ? "es" : r.pais === "DE" ? "de" : r.pais === "FR" ? "fr" : "it"}/dp/${escapeHtml(r.asin)}">${escapeHtml(r.asin)}</a>` : "—";
      const motivos = r.motivos.map((m) => escapeHtml(m.length > 220 ? `${m.slice(0, 220)}…` : m)).join("<br>");
      return `<tr><td style="${cell}">${escapeHtml(r.sku)}</td><td style="${cell}">${r.pais}</td><td style="${cell}">${asin}</td><td style="${cell};text-align:right">${r.unidades}</td><td style="${cell}">${motivos}</td></tr>`;
    })
    .join("");
  const head = ["SKU", "País", "ASIN", "Unidades FBA", "Motivo"].map((h) => `<th style="${cell};text-align:left;background:#f4f4f4">${h}</th>`).join("");
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
<p>Revisión del ${escapeHtml(date)}: <b>${rows.length}</b> listing${rows.length === 1 ? "" : "s"} FBA con unidades vendibles en almacenes de Amazon no está${rows.length === 1 ? "" : "n"} a la venta.</p>
<table style="border-collapse:collapse;font-size:13px">${`<tr>${head}</tr>`}${body}</table>
<p style="color:#777;font-size:12px">Vigilante FBA (GitHub Actions, backend/scripts/watch-inactive-fba.ts). Informe completo en Supabase: alerts:fba-inactive:last-run.</p>
</div>`;
}
