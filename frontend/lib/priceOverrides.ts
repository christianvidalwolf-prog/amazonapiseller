/** Excepciones de precio que prevalecen sobre las reglas generales. */
const FIXED_PRICE_OVERRIDES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "5878SGFBA": {
    A1PA6795UKMFR9: 39.99, // Alemania
    APJ6JRA9NG5V4: 39.99, // Italia
    A13V1IB3VIYZZH: 39.99, // Francia
  },
  "25410RGSGFBA": {
    A1PA6795UKMFR9: 35, // Alemania
    A13V1IB3VIYZZH: 39, // Francia
    APJ6JRA9NG5V4: 39, // Italia
  },
  "6047SGFBA": {
    A1PA6795UKMFR9: 27, // Alemania
    A13V1IB3VIYZZH: 29.99, // Francia
    APJ6JRA9NG5V4: 29.99, // Italia
  },
};

export function fixedPriceForSku(sku: string, marketplaceId: string, requestedPrice: number): number {
  return FIXED_PRICE_OVERRIDES[sku]?.[marketplaceId] ?? requestedPrice;
}
