/**
 * Vigilante FBA: listings con stock vendible en almacenes de Amazon que no están a la venta (no BUYABLE).
 * Lógica pura (sin SP-API): clasificar un listing.
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
