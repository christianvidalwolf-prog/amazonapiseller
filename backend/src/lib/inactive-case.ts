/**
 * Equipo de agentes de listings inactivos: clasificación de un listing FBA con stock que no está
 * BUYABLE en un país, y planificación del arreglo automático.
 *
 * Lógica pura (sin SP-API ni red), para poder probarla: la usan
 * `scripts/agents/inactive-listings.ts` (escáner + corrector + verificador) y sus tests.
 * La tabla código → causa → arreglo vive en `docs/runbooks/listings-inactivos.md`; este módulo es
 * su versión ejecutable.
 */

/** Arreglo que el corrector puede aplicar por API. */
export type FixAction =
  | "bounds" // límites de precio / umbral mínimo 18155 / oferta caducada
  | "fill-price" // oferta sin precio normal (solo B2B o `our_price` vacío)
  | "create-offer" // stock en el país pero el SKU no existe allí
  | "gpsr" // 100632 de seguridad del producto (GPSR)
  | "wait" // Amazon la está revisando (100521): no se toca
  | "escalate" // no hay arreglo por API: Seller Central
  | "ignore"; // no es una incidencia (devoluciones amzn.gr.*)

export interface CaseIssue {
  code: string;
  message: string;
  severity: string;
}

export interface OfferState {
  /** Hay oferta para consumidor (`audience: ALL`) en ese país. */
  hasNormal: boolean;
  /** Esa oferta tiene `our_price` con importe. */
  hasPrice: boolean;
  /** Hay oferta para empresas (`audience: B2B`). */
  hasBusiness: boolean;
  /** La oferta arrastra una promoción o un `end_at` ya vencidos. */
  hasExpiredSale: boolean;
}

export interface InactiveCase {
  sku: string;
  country: string;
  asin: string | null;
  units: number;
  status: string[];
  issues: CaseIssue[];
  /** El SKU tiene registro (summaries) en ese marketplace. */
  exists: boolean;
  productType?: string | null;
  offer: OfferState;
}

export interface Classification {
  action: FixAction;
  auto: boolean;
  /** Diagnóstico legible (va al email y al registro de casos). */
  reason: string;
  codes: string[];
}

export const caseKey = (c: Pick<InactiveCase, "sku" | "country">) => `${c.sku}|${c.country}`;

/** Códigos de Amazon sin arreglo por API (cumplimiento, marca, imágenes, idioma). */
const COMPLIANCE_CODES: Record<string, string> = {
  "100390": "documentación de categoría pendiente en Seller Central",
  "19084": "producto sujeto a restricciones de categoría",
  "19098": "el GTIN no coincide con la marca (exención o caso a soporte)",
  "18146": "uso indebido de marcas en el texto o las imágenes",
  "18570": "necesita autorización para vender esa marca (brand gating) en Seller Central",
  "18967": "seguridad del producto: revisar en Seller Central",
  "18644": "la imagen principal no tiene fondo blanco",
  "100720": "palabras clave en un idioma distinto al del país",
  "13013": "el producto no está en el catálogo de ese país: crear la ficha completa",
  "90220": "atributos obligatorios de la ficha rechazados por Amazon",
};

/** 100632 cubre GPSR (automatizable) y RAP/EPR (no): decide el mensaje de Amazon. */
const isGpsrIssue = (issue: CaseIssue) =>
  issue.code === "100632" && /gpsr|seguridad del producto|product safety|safety attestation/i.test(issue.message);

/** 18155, 18639 y 99022 (promoción guardada sin importe) son problemas de precio: los resuelven los
 * límites o el precio normal. */
const PRICE_CODES = new Set(["18155", "18639", "99022"]);

/** Unidades de medida mal escritas: necesitan el enum exacto del Product Type Definition. */
const UNIT_CODES = new Set(["90244"]);

export function classifyCase(c: InactiveCase): Classification {
  const errors = c.issues.filter((i) => i.severity === "ERROR");
  const codes = [...new Set(errors.map((i) => i.code))];

  if (c.sku.startsWith("amzn.gr.")) {
    return { action: "ignore", auto: false, reason: "SKU de devoluciones (Grade and Resell): Amazon los crea solo donde quiere", codes };
  }

  if (codes.includes("100521")) {
    return { action: "wait", auto: false, reason: "Amazon está revisando el anuncio (48 h); no se reenvía", codes };
  }

  if (!c.exists) {
    return c.asin
      ? { action: "create-offer", auto: true, reason: "El SKU no existe en este marketplace y hay stock: crear la oferta sobre el mismo ASIN", codes }
      : { action: "escalate", auto: false, reason: "El SKU no existe en el marketplace y no hay ASIN con el que recrearlo", codes };
  }

  if (errors.some(isGpsrIssue)) {
    return { action: "gpsr", auto: true, reason: "Faltan los datos GPSR (fabricante y certificación de seguridad)", codes };
  }

  // 100632 sin GPSR es RAP/EPR (registro del productor): no se arregla por API, y como él,
  // el resto de códigos de cumplimiento.
  for (const issue of errors) {
    const reason = COMPLIANCE_CODES[issue.code] ?? (issue.code === "100632" ? "registro RAP/EPR del productor pendiente" : null);
    if (reason) return { action: "escalate", auto: false, reason, codes };
  }

  if (codes.some((code) => UNIT_CODES.has(code))) {
    return { action: "escalate", auto: false, reason: "Unidad de medida (unit_count) fuera del enum del país", codes };
  }

  if (codes.some((code) => PRICE_CODES.has(code))) {
    return { action: "bounds", auto: true, reason: "Precio fuera del umbral de Amazon: corregir límites / precio normal", codes };
  }

  if (!c.offer.hasNormal || !c.offer.hasPrice) {
    return {
      action: "fill-price",
      auto: true,
      reason: c.offer.hasNormal ? "La oferta no tiene precio normal (`our_price` vacío)" : "Oferta solo para empresas: falta la oferta normal",
      codes,
    };
  }

  if (c.offer.hasExpiredSale) {
    return { action: "bounds", auto: true, reason: "La oferta tiene una promoción o un fin de oferta vencidos", codes };
  }

  return {
    action: "bounds",
    auto: true,
    reason: "Sin BUYABLE y sin errores de Amazon: revisar precio y límites de la oferta",
    codes,
  };
}

export interface PlannedCase {
  item: InactiveCase;
  classification: Classification;
  /** Intentos anteriores sin éxito. */
  attempts: number;
  /** Se deja de intentar y pasa a la lista de Seller Central. */
  escalate: boolean;
}

export interface PlanOptions {
  /** Tope de arreglos por ejecución (el resto queda para la siguiente). */
  maxFixes: number;
  /** Intentos previos por `caseKey` (fallidos). */
  attempts?: Record<string, number>;
  /** Intentos antes de escalar (por defecto 2). */
  maxAttempts?: number;
}

export interface Plan {
  /** Arreglos que se intentan en esta ejecución, ya ordenados y limitados. */
  work: PlannedCase[];
  /** Casos que necesitan a una persona (Seller Central) o que ya no se reintentan. */
  manual: PlannedCase[];
}

/**
 * Planifica la ejecución: un arreglo por SKU+país, los de más unidades primero, tope por ejecución.
 * Un caso que ya falló `maxAttempts` veces deja de reintentarse y se escala (evita bucles de escritura).
 */
export function planFixes(cases: InactiveCase[], options: PlanOptions): Plan {
  const seen = new Set<string>();
  const planned: PlannedCase[] = [];

  for (const item of cases) {
    const key = caseKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    const classification = classifyCase(item);
    const attempts = options.attempts?.[key] ?? 0;
    const escalate =
      classification.action === "escalate" ||
      classification.action === "ignore" ||
      (classification.action !== "wait" && attempts >= (options.maxAttempts ?? 2));
    planned.push({ item, classification, attempts, escalate });
  }

  const manual = planned.filter((p) => p.escalate || p.classification.action === "wait" || !p.classification.auto);
  const fixable = planned
    .filter((p) => !manual.includes(p))
    .sort((a, b) => b.item.units - a.item.units || a.item.sku.localeCompare(b.item.sku) || a.item.country.localeCompare(b.item.country));

  return { work: fixable.slice(0, Math.max(0, options.maxFixes)), manual };
}

/** Resumen por acción, para el informe y el email. */
export function summarizePlan(plan: Plan): Record<FixAction, number> {
  const summary: Record<FixAction, number> = { bounds: 0, "fill-price": 0, "create-offer": 0, gpsr: 0, wait: 0, escalate: 0, ignore: 0 };
  for (const p of [...plan.work, ...plan.manual]) summary[p.classification.action] += 1;
  return summary;
}
