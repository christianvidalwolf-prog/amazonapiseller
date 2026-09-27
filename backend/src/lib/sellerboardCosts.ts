/**
 * Lee el coste de un SKU desde los snapshots costs:products:* de Supabase
 * (importados de Sellerboard). Usa el índice costs:products:index (SKU ->
 * chunk) para responder con dos lecturas en lugar de recorrer todos los chunks.
 *
 * Variables: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (opcionales; sin ellas
 * el lector devuelve null y el llamador decide cómo tratarlo).
 */

export interface SellerboardCost {
  sku: string;
  unitCost: number | null;
  vatRate: number | null;
  asin: string | null;
  title: string | null;
  marketplace: string | null;
  costPeriodStartDate: string | null;
  domesticShippingCost: number | null;
  restOfWorldShippingCost: number | null;
  sourceFile: string | null;
}

interface CostRow {
  SKU?: string;
  VAT?: string;
  ASIN?: string;
  Cost?: string;
  Title?: string;
  SourceFile?: string;
  Marketplace?: string;
  CostPeriodStartDate?: string;
  DomesticShippingCost?: string;
  RestofworldShippingCost?: string;
}

interface CostsIndex {
  generatedAt: string;
  rowCount: number;
  chunkCount: number;
  missingChunks: number[];
  bySku: Record<string, number[]>;
}

const INDEX_CACHE_TTL_MS = 15 * 60 * 1000;
let indexCache: { data: CostsIndex; timestamp: number } | null = null;

function supabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  const normalized = url.startsWith("http") ? url : `https://${url}`;
  return { url: normalized.replace(/\/+$/, ""), key };
}

async function readSnapshot<T>(url: string, key: string, snapshotKey: string): Promise<T | null> {
  const res = await fetch(`${url}/rest/v1/snapshots?key=eq.${encodeURIComponent(snapshotKey)}&select=data`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`snapshot ${snapshotKey}: HTTP ${res.status}`);
  const rows = (await res.json()) as Array<{ data: T }>;
  return rows[0]?.data ?? null;
}

async function readIndex(url: string, key: string): Promise<CostsIndex | null> {
  if (indexCache && Date.now() - indexCache.timestamp < INDEX_CACHE_TTL_MS) return indexCache.data;
  const index = await readSnapshot<CostsIndex>(url, key, "costs:products:index");
  if (index) indexCache = { data: index, timestamp: Date.now() };
  return index;
}

const toNumber = (value?: string): number | null => {
  if (!value) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};

export async function getSellerboardCost(skuInput: string): Promise<SellerboardCost | null> {
  const config = supabaseConfig();
  if (!config) return null;
  const sku = skuInput.trim().toUpperCase();

  const index = await readIndex(config.url, config.key);
  if (!index) return null;
  const chunks = index.bySku[sku] ?? [];

  for (const chunk of chunks) {
    const data = await readSnapshot<{ rows: CostRow[] }>(config.url, config.key, `costs:products:${String(chunk).padStart(4, "0")}`);
    for (const row of data?.rows ?? []) {
      if (String(row.SKU ?? "").trim().toUpperCase() !== sku) continue;
      return {
        sku,
        unitCost: toNumber(row.Cost),
        vatRate: toNumber(row.VAT),
        asin: row.ASIN ?? null,
        title: row.Title ?? null,
        marketplace: row.Marketplace ?? null,
        costPeriodStartDate: row.CostPeriodStartDate ?? null,
        domesticShippingCost: toNumber(row.DomesticShippingCost),
        restOfWorldShippingCost: toNumber(row.RestofworldShippingCost),
        sourceFile: row.SourceFile ?? null,
      };
    }
  }
  return null;
}
