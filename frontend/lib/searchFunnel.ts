// Types mirror backend/src/modules/brand-analytics/searchFunnel.types.ts; summarizeFunnel
// mirrors the one in searchFunnel.classifier.ts. Keep them in sync.

export type ReportPeriod = "WEEK" | "MONTH";

export const FUNNEL_STATUSES = [
  "DROP_IMPRESSIONS_TO_CLICKS",
  "DROP_CLICKS_TO_CART",
  "DROP_CART_TO_PURCHASE",
  "WINNER",
  "NORMAL",
  "LOW_VOLUME",
] as const;
export type FunnelStatus = (typeof FUNNEL_STATUSES)[number];

export interface SearchFunnelRow {
  queryText: string;
  asin: string;
  periodStart: string;
  periodEnd: string;
  totalQueryVolume: number;
  totalImpressions: number;
  totalClicks: number;
  totalCartAdds: number;
  totalPurchases: number;
  medianPrice: number | null;
  asinMedianPrice: number | null;
  currency: string | null;
  asinImpressions: number;
  asinImpressionShare: number;
  asinClicks: number;
  asinClickShare: number;
  asinCartAdds: number;
  asinCartAddShare: number;
  asinPurchases: number;
  asinPurchaseShare: number;
  ctr: number;
  cartRate: number;
  purchaseRate: number;
  status: FunnelStatus;
  lostUnits: number;
  impactScore: number;
}

export interface FunnelSummary {
  totalQueries: number;
  dropImpressionsToClicks: number;
  dropClicksToCart: number;
  dropCartToPurchase: number;
  winners: number;
  lostClicks: number;
  lostCartAdds: number;
  lostPurchases: number;
}

export interface SearchFunnelResponse {
  updatedAt: string | null;
  marketplaceId: string;
  period: ReportPeriod;
  periodStart: string | null;
  periodEnd: string | null;
  asins: Array<{ asin: string; name: string }>;
  summary: FunnelSummary;
  rows: SearchFunnelRow[];
}

export interface SearchFunnelSyncStatus {
  state: "idle" | "running" | "done" | "failed";
  period: ReportPeriod | null;
  startedAt: string | null;
  finishedAt: string | null;
  requestedAsins: number;
  rows: number;
  errors: string[];
}

export function summarizeFunnel(rows: SearchFunnelRow[]): FunnelSummary {
  const summary: FunnelSummary = {
    totalQueries: rows.length,
    dropImpressionsToClicks: 0,
    dropClicksToCart: 0,
    dropCartToPurchase: 0,
    winners: 0,
    lostClicks: 0,
    lostCartAdds: 0,
    lostPurchases: 0,
  };
  for (const row of rows) {
    if (row.status === "DROP_IMPRESSIONS_TO_CLICKS") {
      summary.dropImpressionsToClicks += 1;
      summary.lostClicks += row.lostUnits;
    } else if (row.status === "DROP_CLICKS_TO_CART") {
      summary.dropClicksToCart += 1;
      summary.lostCartAdds += row.lostUnits;
    } else if (row.status === "DROP_CART_TO_PURCHASE") {
      summary.dropCartToPurchase += 1;
      summary.lostPurchases += row.lostUnits;
    } else if (row.status === "WINNER") {
      summary.winners += 1;
    }
  }
  summary.lostClicks = Math.round(summary.lostClicks);
  summary.lostCartAdds = Math.round(summary.lostCartAdds);
  summary.lostPurchases = Math.round(summary.lostPurchases);
  return summary;
}

/** Narrows a full-period payload the way the backend endpoint does with ?asin= and ?status=. */
export function filterFunnel(
  payload: SearchFunnelResponse,
  filters: { asin?: string; status?: FunnelStatus }
): SearchFunnelResponse {
  if (!filters.asin && !filters.status) return payload;
  const rows = payload.rows.filter(
    (row) => (!filters.asin || row.asin === filters.asin) && (!filters.status || row.status === filters.status)
  );
  return { ...payload, rows, summary: summarizeFunnel(rows) };
}

export const STATUS_META: Record<FunnelStatus, { label: string; badge: string; action: string }> = {
  DROP_IMPRESSIONS_TO_CLICKS: {
    label: "Fuga en SERP",
    badge: "bg-red-500/15 text-red-300 ring-red-500/40",
    action: "Revisar imagen principal, título y precio visible en resultados",
  },
  DROP_CLICKS_TO_CART: {
    label: "Fuga en ficha",
    badge: "bg-orange-500/15 text-orange-300 ring-orange-500/40",
    action: "Mejorar bullets, A+, imágenes secundarias y reseñas",
  },
  DROP_CART_TO_PURCHASE: {
    label: "Fuga en cierre",
    badge: "bg-amber-500/15 text-amber-300 ring-amber-500/40",
    action: "Comprobar stock, plazo de envío, Buy Box y precio final",
  },
  WINNER: {
    label: "Ganador",
    badge: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40",
    action: "Blindar el término en PPC (exacta)",
  },
  NORMAL: { label: "Normal", badge: "bg-slate-500/15 text-slate-300 ring-slate-500/40", action: "—" },
  LOW_VOLUME: { label: "Poco volumen", badge: "bg-slate-800 text-slate-500 ring-slate-700", action: "—" },
};

const pct = (value: number, decimals = 1): string => `${(value * 100).toFixed(decimals)}%`;
const money = (value: number, currency: string | null): string =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: currency || "EUR" }).format(value);

export interface FunnelDiagnosis {
  /** Where the flow breaks, with the numbers that show it. */
  breakpoint: string;
  cause: string;
  tasks: [string, string, string];
}

/** Rule-based diagnosis: the texts come from the leak category and the row's own numbers, not from a model. */
export function buildDiagnosis(row: SearchFunnelRow): FunnelDiagnosis | null {
  const query = `«${row.queryText}»`;
  const pricier =
    row.asinMedianPrice != null && row.medianPrice != null && row.asinMedianPrice > row.medianPrice * 1.05
      ? `Tu precio mediano (${money(row.asinMedianPrice, row.currency)}) supera al del término (${money(row.medianPrice, row.currency)})`
      : null;

  switch (row.status) {
    case "DROP_IMPRESSIONS_TO_CLICKS":
      return {
        breakpoint: `Impresiones → Clics. El ASIN aparece en el ${pct(row.asinImpressionShare)} de las impresiones de ${query} pero solo se lleva el ${pct(row.asinClickShare)} de los clics (CTR ${pct(row.ctr, 2)}). Unos ${Math.round(row.lostUnits)} clics perdidos en el período.`,
        cause: "El resultado no convence en la página de búsqueda: imagen principal, título, precio visible o falta de cupón / insignia Prime.",
        tasks: [
          "Probar una imagen principal nueva (producto más grande, fondo blanco puro, sin elementos que resten) con un experimento A/B.",
          `Reescribir el inicio del título para que ${query} y el beneficio clave se lean en los primeros 80 caracteres.`,
          pricier
            ? `${pricier}: bajar el precio o añadir un cupón para igualar lo que el cliente ve en el SERP.`
            : "Añadir un cupón del 5% para que el resultado destaque en el SERP frente a los vecinos.",
        ],
      };
    case "DROP_CLICKS_TO_CART":
      return {
        breakpoint: `Clics → Cesta. De ${row.asinClicks} clics en ${query} solo ${row.asinCartAdds} llegaron a la cesta (${pct(row.cartRate, 2)}; el término en conjunto convierte al ${pct(row.totalClicks ? row.totalCartAdds / row.totalClicks : 0, 2)}). Unas ${Math.round(row.lostUnits)} cestas perdidas.`,
        cause: "El cliente entra en la ficha y se va: los bullets, el contenido A+, las imágenes secundarias o las reseñas no responden a lo que buscaba.",
        tasks: [
          `Reescribir los dos primeros bullets respondiendo a la intención de ${query} (uso, medidas, material).`,
          "Reemplazar la imagen secundaria #2 por una de uso/escala y añadir una infografía con las medidas.",
          pricier
            ? `${pricier}: revisar el precio, es la objeción más probable al llegar a la ficha.`
            : "Revisar las reseñas recientes de 1–3 estrellas y contestar la objeción más repetida en el A+.",
        ],
      };
    case "DROP_CART_TO_PURCHASE":
      return {
        breakpoint: `Cesta → Compra. De ${row.asinCartAdds} cestas con ${query} solo se compraron ${row.asinPurchases} (${pct(row.purchaseRate)}). Unas ${Math.round(row.lostUnits)} compras perdidas.`,
        cause: "El cliente quería el producto y no cerró: rotura de stock, plazo de entrega largo, pérdida de la Buy Box o precio final con envío.",
        tasks: [
          "Comprobar stock FBA y fecha de entrega prometida del ASIN durante el período; reponer si hubo días sin stock.",
          "Verificar quién tuvo la Buy Box (panel Precios): si se perdió, ajustar precio u oferta FBA.",
          pricier
            ? `${pricier}: revisar precio final y gastos de envío frente a las alternativas.`
            : "Revisar gastos de envío y precio final en el checkout frente a los competidores del término.",
        ],
      };
    case "WINNER":
      return {
        breakpoint: `Sin fuga. El ASIN se lleva el ${pct(row.asinPurchaseShare)} de las compras de ${query} y convierte el ${pct(row.purchaseRate)} de sus cestas.`,
        cause: "Término de alto rendimiento: conviene protegerlo antes de que un competidor puje por él.",
        tasks: [
          `Blindar ${query} en concordancia exacta en Sponsored Products con puja de defensa.`,
          "Añadir el término a una campaña Sponsored Brands para ocupar también la cabecera.",
          "Asegurar cobertura de stock: una rotura aquí cede la cuota a la competencia.",
        ],
      };
    default:
      return null;
  }
}
