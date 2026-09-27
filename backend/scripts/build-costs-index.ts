/**
 * Builds the SKU -> chunk index snapshot (costs:products:index) from the
 * per-chunk cost snapshots (costs:products:0001, ...). This lets the frontend
 * answer "what does SKU X cost?" with two requests instead of scanning every
 * chunk.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Optional: DRY_RUN=1.
 */
const rawUrl = (process.env.SUPABASE_URL ?? "").trim();
const SUPABASE_URL = rawUrl.startsWith("http") ? rawUrl.replace(/\/+$/, "") : `https://${rawUrl.replace(/\/+$/, "")}`;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const DRY_RUN = process.env.DRY_RUN === "1";

if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_KEY)) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or set DRY_RUN=1)");
  process.exit(1);
}

const headers = { apikey: SUPABASE_KEY!, Authorization: `Bearer ${SUPABASE_KEY}` };
const pad = (n: number) => String(n).padStart(4, "0");

async function readSnapshot<T>(key: string): Promise<T | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/snapshots?key=eq.${encodeURIComponent(key)}&select=data`, {
    headers,
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`snapshot ${key}: HTTP ${res.status}`);
  const rows = (await res.json()) as Array<{ data: T }>;
  return rows[0]?.data ?? null;
}

async function upsert(key: string, data: unknown): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/snapshots?on_conflict=key`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`upsert ${key}: HTTP ${res.status} ${await res.text()}`);
}

interface CostRow {
  SKU: string;
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

interface Meta {
  rowCount?: number;
  chunkSize?: number;
  chunkCount?: number;
  source?: string;
  importedAt?: string;
}

async function main(): Promise<void> {
  const meta = await readSnapshot<Meta>("costs:products:meta");
  const chunkCount = meta?.chunkCount ?? 0;
  if (!chunkCount) {
    console.error("costs:products:meta not found or has no chunkCount — run the costs import first");
    process.exit(1);
  }

  let nextChunk = 1;
  const missing: number[] = [];
  const bySku = new Map<string, number[]>();
  let rowCount = 0;

  async function worker(): Promise<void> {
    while (true) {
      const chunk = nextChunk++;
      if (chunk > chunkCount) return;
      const data = await readSnapshot<{ rows: CostRow[] }>(`costs:products:${pad(chunk)}`);
      if (!data || !Array.isArray(data.rows)) {
        missing.push(chunk);
        continue;
      }
      rowCount += data.rows.length;
      for (const row of data.rows) {
        const sku = String(row.SKU ?? "").trim().toUpperCase();
        if (!sku) continue;
        const chunks = bySku.get(sku);
        if (!chunks) bySku.set(sku, [chunk]);
        else if (!chunks.includes(chunk)) chunks.push(chunk);
      }
    }
  }

  await Promise.all(Array.from({ length: 8 }, () => worker()));

  const index = {
    generatedAt: new Date().toISOString(),
    source: meta?.source ?? null,
    importedAt: meta?.importedAt ?? null,
    rowCount,
    chunkCount,
    missingChunks: missing,
    bySku: Object.fromEntries(bySku),
  };

  const skuCount = bySku.size;
  console.log(
    `index ready: ${skuCount} SKUs, ${rowCount} rows, ${chunkCount - missing.length}/${chunkCount} chunks` +
      (missing.length ? `, MISSING: ${missing.map(pad).join(",")}` : "")
  );
  if (meta?.rowCount && rowCount !== meta.rowCount) {
    console.warn(`warning: meta.rowCount=${meta.rowCount} but ${rowCount} rows were indexed`);
  }

  if (DRY_RUN) {
    console.log("[dry-run] not uploading");
    return;
  }
  await upsert("costs:products:index", index);
  console.log("ok   costs:products:index published");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
