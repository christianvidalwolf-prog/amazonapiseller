export function parsePriceInput(value: string | number): number {
  const price = typeof value === "number" ? value : Number(value.replace(",", "."));
  if (!Number.isFinite(price) || price < 0) throw new Error("Introduce un precio válido.");
  return Number(price.toFixed(2));
}
