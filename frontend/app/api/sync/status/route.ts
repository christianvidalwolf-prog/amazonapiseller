import { notAvailableInProduction } from "@/lib/snapshots";

export function GET() {
  return notAvailableInProduction("El panel de sincronización");
}
