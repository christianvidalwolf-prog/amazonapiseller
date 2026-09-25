/** Debe coincidir con BSR_MARKETPLACES del backend (backend/src/modules/bsr/bsr.marketplaces.ts). */
export const BSR_MARKETPLACES = [
  { code: "ES", name: "Amazon.es (España)" },
  { code: "DE", name: "Amazon.de (Alemania)" },
  { code: "FR", name: "Amazon.fr (Francia)" },
  { code: "IT", name: "Amazon.it (Italia)" },
] as const;

export const DEFAULT_BSR_MARKETPLACE = "ES";

/**
 * Lee ?marketplace= de la petición. Devuelve el código validado, o null si no es
 * válido. El marketplace por defecto usa las claves de snapshot sin sufijo.
 */
export function bsrMarketplaceParams(searchParams: URLSearchParams): { code: string; keyPrefix: string; query: string } | null {
  const code = (searchParams.get("marketplace") || DEFAULT_BSR_MARKETPLACE).toUpperCase();
  if (!BSR_MARKETPLACES.some((m) => m.code === code)) return null;
  if (code === DEFAULT_BSR_MARKETPLACE) return { code, keyPrefix: "", query: "" };
  return { code, keyPrefix: `${code}:`, query: `marketplace=${code}` };
}
