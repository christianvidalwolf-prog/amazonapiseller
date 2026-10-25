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
  "2890438CLMFBA": {
    A1PA6795UKMFR9: 35, // Alemania
    A13V1IB3VIYZZH: 39, // Francia
    APJ6JRA9NG5V4: 39, // Italia
  },
  "2684319CLMFBA": {
    A1PA6795UKMFR9: 19.99, // Alemania
    A13V1IB3VIYZZH: 23.99, // Francia
    APJ6JRA9NG5V4: 23.99, // Italia
  },
  "22212445CLMFBA": {
    A1PA6795UKMFR9: 29, // Alemania
    A13V1IB3VIYZZH: 34, // Francia
    APJ6JRA9NG5V4: 34, // Italia
  },
  "27760SGRGFBA": {
    A1PA6795UKMFR9: 35, // Alemania
    A13V1IB3VIYZZH: 39, // Francia
    APJ6JRA9NG5V4: 39, // Italia
  },
  "880VCIFBA": {
    A1PA6795UKMFR9: 21, // Alemania
    A13V1IB3VIYZZH: 22, // Francia
    APJ6JRA9NG5V4: 22, // Italia
  },
};

export function fixedPriceForSku(sku: string, marketplaceId: string, requestedPrice: number): number {
  return FIXED_PRICE_OVERRIDES[sku]?.[marketplaceId] ?? requestedPrice;
}
