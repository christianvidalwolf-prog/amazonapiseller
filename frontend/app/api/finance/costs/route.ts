import { NextRequest, NextResponse } from "next/server";
import { readSnapshot } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

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

interface CostsIndex {
  generatedAt: string;
  source?: string | null;
  importedAt?: string | null;
  rowCount: number;
  chunkCount: number;
  missingChunks: number[];
  bySku: Record<string, number[]>;
}

interface MarginSnapshotItem {
  sku: string;
  title: string | null;
  currency: string;
  price: number | null;
  fees: { total: number | null; referral: number | null; fulfillment: number | null };
  cost: { unitCost: number | null; domesticShippingCost: number | null; vatRate: number | null };
  landedCost: number | null;
  margin: number | null;
  marginPct: number | null;
  error: string | null;
}

const toNumber = (value?: string): number | null => {
  if (!value) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};

export async function GET(req: NextRequest) {
  const sku = req.nextUrl.searchParams.get("sku")?.trim().toUpperCase() ?? "";

  let index: CostsIndex | null = null;
  try {
    const row = await readSnapshot("costs:products:index");
    index = (row?.data as CostsIndex) ?? null;
  } catch (err) {
    return NextResponse.json(
      { error: "supabase_not_configured", message: err instanceof Error ? err.message : "Supabase no configurado" },
      { status: 503 }
    );
  }
  if (!index) {
    return NextResponse.json(
      { error: "costs_index_not_ready", message: "No existe el snapshot costs:products:index. Ejecuta el paso 'Rebuild costs index' del workflow." },
      { status: 404 }
    );
  }

  if (!sku) {
    return NextResponse.json({
      rowCount: index.rowCount,
      skuCount: Object.keys(index.bySku).length,
      chunkCount: index.chunkCount,
      missingChunks: index.missingChunks,
      generatedAt: index.generatedAt,
      importedAt: index.importedAt,
      source: index.source,
    });
  }

  const chunks = index.bySku[sku] ?? [];
  const results: Array<Record<string, unknown>> = [];
  for (const chunk of chunks) {
    const chunkRow = await readSnapshot(`costs:products:${String(chunk).padStart(4, "0")}`);
    const data = ((chunkRow?.data as { rows?: CostRow[] } | null)?.rows ?? []) as CostRow[];
    for (const row of data) {
      if (String(row.SKU ?? "").trim().toUpperCase() !== sku) continue;
      results.push({
        sku: row.SKU,
        cost: toNumber(row.Cost),
        vat: toNumber(row.VAT),
        asin: row.ASIN,
        title: row.Title,
        marketplace: row.Marketplace,
        costPeriodStartDate: row.CostPeriodStartDate,
        domesticShippingCost: toNumber(row.DomesticShippingCost),
        restofworldShippingCost: toNumber(row.RestofworldShippingCost),
        sourceFile: row.SourceFile,
      });
    }
  }

  // Margen unitario precalculado por el workflow (snapshot margins:products).
  let marginItem: MarginSnapshotItem | null = null;
  let marginUpdatedAt: string | null = null;
  try {
    const marginsRow = await readSnapshot("margins:products");
    const margins = ((marginsRow?.data as { items?: MarginSnapshotItem[] } | null)?.items ?? []) as MarginSnapshotItem[];
    marginItem = margins.find((m) => String(m.sku ?? "").trim().toUpperCase() === sku) ?? null;
    marginUpdatedAt = marginsRow?.updated_at ?? null;
  } catch {
    // El snapshot de márgenes todavía no existe: se omite sin romper la búsqueda.
  }

  return NextResponse.json({ sku, results, margin: marginItem, marginUpdatedAt });
}
