export interface BsrMarketplace {
  code: string;
  id: string;
  /** Valor de la columna sales-channel del informe de pedidos. */
  salesChannel: string;
}

/** Marketplaces con ventas reales; ES es el marketplace por defecto de la cuenta. */
export const BSR_MARKETPLACES: BsrMarketplace[] = [
  { code: "ES", id: "A1RKKUPIHCS9HS", salesChannel: "Amazon.es" },
  { code: "DE", id: "A1PA6795UKMFR9", salesChannel: "Amazon.de" },
  { code: "FR", id: "A13V1IB3VIYZZH", salesChannel: "Amazon.fr" },
  { code: "IT", id: "APJ6JRA9NG5V4", salesChannel: "Amazon.it" },
];

export function findBsrMarketplace(code: string): BsrMarketplace | undefined {
  return BSR_MARKETPLACES.find((m) => m.code === code.toUpperCase());
}
