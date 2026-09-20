import { notAvailableInProduction } from "@/lib/snapshots";

export function GET() {
  return notAvailableInProduction("El detalle de ofertas por ASIN");
}
