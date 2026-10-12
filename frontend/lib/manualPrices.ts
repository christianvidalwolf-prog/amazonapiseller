/**
 * Precios cambiados a mano desde el panel: se guardan en Supabase (`snapshots`, una fila por SKU y país,
 * clave `rules:manual-price:<sku>:<país>`) para que sean permanentes. Los respetan el feed diario de
 * stock (sync_daily_stock_amz.py vía price_overrides.py), los precios fijos nocturnos, la regla del suelo
 * FBM y la réplica FBA. frontend/lib/manualPrices.ts es una copia de este módulo y debe mantenerse igual.
 */

export const MANUAL_PRICE_PREFIX = "rules:manual-price:";

const COUNTRY_BY_MARKETPLACE: Readonly<Record<string, string>> = {
  A1RKKUPIHCS9HS: "ES",
  A1PA6795UKMFR9: "DE",
  A13V1IB3VIYZZH: "FR",
  APJ6JRA9NG5V4: "IT",
};

export interface ManualPrice {
  sku: string;
  country: string;
  marketplaceId: string;
  price: number;
  recordedAt: string;
  source: "panel";
}

function supabase(): { url: string; key: string } | null {
  const raw = (process.env.SUPABASE_URL ?? "").trim();
  const url = (raw && !/^https?:\/\//.test(raw) ? `https://${raw}` : raw).replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return url && key ? { url, key } : null;
}

/** Guarda el precio aceptado por Amazon. Devuelve false si no se pudo guardar (sin Supabase o marketplace fuera de ES/DE/FR/IT). */
export async function recordManualPrice(sku: string, marketplaceId: string, price: number): Promise<boolean> {
  const db = supabase();
  const country = COUNTRY_BY_MARKETPLACE[marketplaceId];
  if (!db || !country) return false;
  const data: ManualPrice = { sku, country, marketplaceId, price: Number(price.toFixed(2)), recordedAt: new Date().toISOString(), source: "panel" };
  try {
    const res = await fetch(`${db.url}/rest/v1/snapshots?on_conflict=key`, {
      method: "POST",
      headers: { apikey: db.key, Authorization: `Bearer ${db.key}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key: `${MANUAL_PRICE_PREFIX}${sku}:${country}`, data, updated_at: data.recordedAt }),
    });
    if (!res.ok) console.warn(`No se pudo guardar el precio manual de ${sku} (${country}): ${res.status} ${await res.text()}`);
    return res.ok;
  } catch (e) {
    console.warn(`No se pudo guardar el precio manual de ${sku} (${country}):`, e);
    return false;
  }
}

/** Todos los precios manuales guardados. Sin Supabase devuelve una lista vacía. */
export async function loadManualPrices(): Promise<ManualPrice[]> {
  const db = supabase();
  if (!db) return [];
  const out: ManualPrice[] = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const res = await fetch(
      `${db.url}/rest/v1/snapshots?key=like.${encodeURIComponent(`${MANUAL_PRICE_PREFIX}*`)}&select=data&order=key&limit=${page}&offset=${offset}`,
      { headers: { apikey: db.key, Authorization: `Bearer ${db.key}` } }
    );
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as Array<{ data: ManualPrice }>;
    out.push(...rows.map((r) => r.data));
    if (rows.length < page) return out;
  }
}

/** Claves `${sku}|${país}` con precio manual, para que las reglas automáticas no las toquen. */
export async function manualPriceKeys(): Promise<Set<string>> {
  return new Set((await loadManualPrices()).map((m) => `${m.sku}|${m.country}`));
}
