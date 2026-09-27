/**
 * Regla de límites de precio para los FBA en ES/DE/FR/IT (ver src/lib/priceBounds.ts):
 * con oferta, mínimo = mitad del precio de oferta; si el precio supera el máximo, máximo = doble del precio.
 *
 * Por defecto solo informa. Env:
 *   PRICE_BOUNDS_APPLY=1  → envía los cambios a Amazon.
 *   CATALOG_CSV           → ruta a catalogo_completo.csv (por defecto ../catalogo_completo.csv).
 *   SKUS                  → lista separada por comas para revisar solo esos SKU.
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY → informe en snapshots (rules:price-bounds:last-run).
 */
import fs from "node:fs";
import path from "node:path";
import { env } from "../src/config/env";
import { priceBoundsFix, readOfferPrices, withBounds } from "../src/lib/priceBounds";
import { EU_MARKETPLACES } from "../src/modules/account-health/account-health.service";
import { SpApiClient } from "../src/spapi/client";
import { getListingsItem, patchListingsItem } from "../src/spapi/endpoints/listingsItems";
import { esFbaListingsFromCatalog } from "./lib/fba-replication";

const APPLY = process.env.PRICE_BOUNDS_APPLY === "1";
const CATALOG = process.env.CATALOG_CSV ?? path.resolve(process.cwd(), "..", "catalogo_completo.csv");
const REPORT_KEY = "rules:price-bounds:last-run";
const COUNTRIES = ["ES", "DE", "FR", "IT"] as const;

const supabaseUrl = (() => {
  const raw = (process.env.SUPABASE_URL ?? "").trim();
  return (raw && !/^https?:\/\//.test(raw) ? `https://${raw}` : raw).replace(/\/+$/, "");
})();
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

async function writeReport(data: unknown): Promise<void> {
  if (!supabaseUrl || !supabaseKey) return;
  const res = await fetch(`${supabaseUrl}/rest/v1/snapshots?on_conflict=key`, {
    method: "POST",
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: REPORT_KEY, data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase upsert ${REPORT_KEY} ${res.status}: ${await res.text()}`);
}

const client = new SpApiClient({ credentials: env.spApi });
const isNotFound = (e: unknown) => /NOT_FOUND|not found/i.test(String(e));

async function main() {
  const now = new Date();
  const only = (process.env.SKUS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const skus = only.length ? only : [...new Set(esFbaListingsFromCatalog(fs.readFileSync(CATALOG, "utf-8")).map((l) => l.sku))];
  const report: any[] = [];
  let checked = 0;

  for (const sku of skus) {
    for (const code of COUNTRIES) {
      const mid = EU_MARKETPLACES[code].id;
      try {
        let listing: any;
        try {
          listing = await getListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [mid], includedData: ["attributes", "summaries"] });
        } catch (e) {
          if (isNotFound(e)) continue;
          throw e;
        }
        const offer = (listing?.attributes?.purchasable_offer || []).find((o: any) => (o.audience ?? "ALL") === "ALL" && (o.marketplace_id ?? mid) === mid);
        if (!offer) continue;
        checked++;
        const prices = readOfferPrices(offer, now);
        const fix = priceBoundsFix(prices);
        if (fix.min == null && fix.max == null) continue;
        const row = { sku, pais: code, precio: prices.price, oferta: prices.sale, min: prices.min, max: prices.max, nuevo_min: fix.min, nuevo_max: fix.max };
        if (!APPLY) {
          report.push({ ...row, result: "a ajustar (sin aplicar)" });
          continue;
        }
        const r = await patchListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [mid] }, {
          productType: listing.summaries?.[0]?.productType ?? "PRODUCT",
          patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: [withBounds({ ...offer, marketplace_id: mid }, fix)] }],
        });
        report.push({ ...row, result: r.status === "ACCEPTED" ? "ajustado" : "rechazado", ...(r.status === "ACCEPTED" ? {} : { detail: JSON.stringify(r.issues ?? r.status) }) });
      } catch (e) {
        report.push({ sku, pais: code, result: "error", detail: String(e).slice(0, 200) });
      }
    }
  }

  const summary: Record<string, number> = {};
  for (const r of report) summary[r.result] = (summary[r.result] ?? 0) + 1;
  await writeReport({ at: now.toISOString(), apply: APPLY, skus: skus.length, ofertas: checked, summary, items: report });
  console.log(`Price bounds ${APPLY ? "APPLY" : "DRY-RUN"} | SKU ${skus.length} | ofertas ${checked} | ${JSON.stringify(summary)}`);
  for (const r of report) console.log(" ", JSON.stringify(r));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
