/** Excepciones de precio que prevalecen sobre las reglas generales. */
const FIXED_PRICE_OVERRIDES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "5878SGFBA": {
    A1PA6795UKMFR9: 39.99, // Alemania
    APJ6JRA9NG5V4: 39.99, // Italia
    A13V1IB3VIYZZH: 39.99, // Francia
  },
};

export function fixedPriceForSku(sku: string, marketplaceId: string, requestedPrice: number): number {
  return FIXED_PRICE_OVERRIDES[sku]?.[marketplaceId] ?? requestedPrice;
}
