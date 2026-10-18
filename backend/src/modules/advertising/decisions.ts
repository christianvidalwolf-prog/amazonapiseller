import { createHash } from "node:crypto";

/**
 * Human decisions on proposals from the daily report (spec advertising §12). Each proposal gets a
 * short, stable code — country + 6 hex chars of its id — that the user writes in
 * `informes-ads/decisiones.txt` as `ES-3f9a2c SI` or `ES-3f9a2c NO` (also accepted: aprobar/rechazar,
 * yes/no). Lines starting with # are comments.
 */

export type Verdict = "approved" | "rejected";

export const proposalCode = (country: string, id: string) => `${country}-${createHash("sha1").update(id).digest("hex").slice(0, 6)}`;

const YES = new Set(["si", "sí", "s", "yes", "y", "aprobar", "aprobado", "ok", "1"]);
const NO = new Set(["no", "n", "rechazar", "rechazado", "0"]);

export interface ParsedDecision {
  code: string;
  verdict: Verdict;
  line: number;
}

export interface ParseResult {
  decisions: ParsedDecision[];
  invalid: Array<{ line: number; text: string }>;
}

export function parseDecisions(text: string): ParseResult {
  const decisions: ParsedDecision[] = [];
  const invalid: ParseResult["invalid"] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = /^([A-Z]{2}-[0-9a-f]{6})\s+(\S+)/i.exec(line);
    const word = m?.[2].toLowerCase();
    if (!m || !word || (!YES.has(word) && !NO.has(word))) {
      invalid.push({ line: i + 1, text: line });
      return;
    }
    decisions.push({ code: `${m[1].slice(0, 2).toUpperCase()}${m[1].slice(2).toLowerCase()}`, verdict: YES.has(word) ? "approved" : "rejected", line: i + 1 });
  });
  return { decisions, invalid };
}

/** The file after a run: processed lines move to a dated comment so they are never applied twice. */
export function markProcessed(text: string, processed: Map<number, string>, date: string): string {
  return text
    .split(/\r?\n/)
    .map((raw, i) => (processed.has(i + 1) ? `# [${date} ${processed.get(i + 1)}] ${raw.trim()}` : raw))
    .join("\n");
}

export const DECISIONS_TEMPLATE = `# Decisiones sobre las propuestas de Amazon Ads
# Una línea por propuesta: el código del informe diario seguido de SI o NO.
#   ES-3f9a2c SI    → se aplica en Amazon en la próxima ejecución (9:00)
#   ES-3f9a2c NO    → se rechaza y no se vuelve a proponer
# Las líneas procesadas quedan comentadas con la fecha y el resultado.
`;
