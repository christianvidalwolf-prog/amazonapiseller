/**
 * Regla de réplica de ofertas FBA (ES → DE/FR/IT). Ver scripts/lib/fba-replication.ts.
 *
 * Por defecto solo valida (VALIDATION_PREVIEW) y no escribe nada en Amazon.
 * Env:
 *   FBA_REPLICATION_APPLY=1   → crea ofertas y ajusta precios de verdad.
 *   CATALOG_CSV               → ruta a catalogo_completo.csv (por defecto ../catalogo_completo.csv).
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY → estado e informe en la tabla snapshots;
 *     sin ellas se usa backend/data/fba-replication-state.json.
 */
import fs from "node:fs";
import path from "node:path";
import { env } from "../src/config/env";
import { EU_MARKETPLACES } from "../src/modules/account-health/account-health.service";
import { SpApiClient } from "../src/spapi/client";
import { priceBoundsFix, readOfferPrices, withBounds } from "../src/lib/priceBounds";
import { getListingsItem } from "../src/spapi/endpoints/listingsItems";
import {
  copyAttributesFor,
  esFbaListingsFromCatalog,
  managedKey,
  offerOnlyPayload,
  planRun,
  type ReplicationState,
  type TargetCode,
  targetPriceForSku,
} from "./lib/fba-replication";

const APPLY = process.env.FBA_REPLICATION_APPLY === "1";
const CATALOG = process.env.CATALOG_CSV ?? path.resolve(process.cwd(), "..", "catalogo_completo.csv");
const STATE_KEY = "rules:fba-replication:state";
const REPORT_KEY = "rules:fba-replication:last-run";
const LOCAL_STATE = path.resolve(process.cwd(), "data", "fba-replication-state.json");
const ES = EU_MARKETPLACES.ES.id;

const supabaseUrl = (() => {
  const raw = (process.env.SUPABASE_URL ?? "").trim();
  return (raw && !/^https?:\/\//.test(raw) ? `https://${raw}` : raw).replace(/\/+$/, "");
})();
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const useSupabase = Boolean(supabaseUrl && supabaseKey);

async function readJson<T>(key: string): Promise<T | null> {
  if (!useSupabase) return key === STATE_KEY && fs.existsSync(LOCAL_STATE) ? JSON.parse(fs.readFileSync(LOCAL_STATE, "utf-8")) : null;
  const res = await fetch(`${supabaseUrl}/rest/v1/snapshots?key=eq.${encodeURIComponent(key)}&select=data`, {
    headers: { apikey: supabaseKey!, Authorization: `Bearer ${supabaseKey}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as Array<{ data: T }>;
  return rows[0]?.data ?? null;
}

async function writeJson(key: string, data: unknown): Promise<void> {
  if (!useSupabase) {
    const file = key === STATE_KEY ? LOCAL_STATE : LOCAL_STATE.replace("state", "last-run");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 1));
    return;
  }
  const res = await fetch(`${supabaseUrl}/rest/v1/snapshots?on_conflict=key`, {
    method: "POST",
    headers: { apikey: supabaseKey!, Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase upsert ${key} ${res.status}: ${await res.text()}`);
}

const client = new SpApiClient({ credentials: env.spApi });
const isNotFound = (e: unknown) => /NOT_FOUND|not found/i.test(String(e));

async function getListing(sku: string, marketplaceId: string): Promise<any | null> {
  try {
    return await getListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [marketplaceId], includedData: ["attributes", "summaries"] });
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

const allOffer = (listing: any, marketplaceId: string) =>
  (listing?.attributes?.purchasable_offer || []).find((o: any) => (o.audience ?? "ALL") === "ALL" && (o.marketplace_id ?? marketplaceId) === marketplaceId);
const ourPrice = (listing: any, marketplaceId: string): number | null => allOffer(listing, marketplaceId)?.our_price?.[0]?.schedule?.[0]?.value_with_tax ?? null;

async function putOffer(sku: string, marketplaceId: string, body: unknown, preview: boolean): Promise<any> {
  return client.request<any>({
    method: "PUT",
    path: `/listings/2021-08-01/items/${env.sellerId}/${encodeURIComponent(sku)}`,
    query: { marketplaceIds: marketplaceId, ...(preview ? { mode: "VALIDATION_PREVIEW" } : {}) },
    body,
    rateLimitKey: "listingsItems.putListingsItem",
  });
}

/** Crea la oferta; si Amazon pide atributos obligatorios que ES sí tiene, los copia y revalida una vez. */
async function createOffer(sku: string, asin: string, code: TargetCode, esListing: any, price: number) {
  const mid = EU_MARKETPLACES[code].id;
  const productType = esListing.summaries?.[0]?.productType;
  if (!productType) return { result: "pendiente", detail: "sin productType en ES" };
  let payload = offerOnlyPayload({ productType, asin, marketplaceId: mid, price });
  let check = await putOffer(sku, mid, payload, true);
  if (check.status !== "VALID") {
    const missing: string[] = (check.issues || []).filter((i: any) => i.severity === "ERROR").flatMap((i: any) => i.attributeNames || []);
    const extra = copyAttributesFor(esListing.attributes, missing, mid);
    if (Object.keys(extra).length) {
      payload = offerOnlyPayload({ productType, asin, marketplaceId: mid, price, extra });
      check = await putOffer(sku, mid, payload, true);
    }
  }
  if (check.status !== "VALID") {
    const errors = (check.issues || []).filter((i: any) => i.severity === "ERROR").map((i: any) => `${i.code} ${i.attributeNames?.join(",") ?? ""}: ${i.message}`);
    return { result: "pendiente", detail: errors.join(" | ") || check.status };
  }
  if (!APPLY) return { result: "validado (sin aplicar)" };
  const r = await putOffer(sku, mid, payload, false);
  return r.status === "ACCEPTED" ? { result: "creada", submissionId: r.submissionId } : { result: "rechazada", detail: JSON.stringify(r.issues ?? r.status) };
}

async function syncPrice(sku: string, code: TargetCode, existing: any, target: number) {
  const mid = EU_MARKETPLACES[code].id;
  const current = ourPrice(existing, mid);
  if (current === target) return { result: "ok" };
  if (!APPLY) return { result: "precio a ajustar (sin aplicar)", from: current, to: target };
  // replace del precio de venta: Amazon lo fusiona con la oferta existente y conserva mínimo/máximo,
  // salvo que haya que moverlos para que el precio nuevo quede dentro (src/lib/priceBounds.ts).
  const fix = priceBoundsFix({ ...readOfferPrices(allOffer(existing, mid)), price: target });
  const r = await client.request<any>({
    method: "PATCH",
    path: `/listings/2021-08-01/items/${env.sellerId}/${encodeURIComponent(sku)}`,
    query: { marketplaceIds: mid },
    body: { productType: "PRODUCT", patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: [withBounds({ marketplace_id: mid, currency: "EUR", audience: "ALL", our_price: [{ schedule: [{ value_with_tax: target }] }] }, fix)] }] },
    rateLimitKey: "listingsItems.patchListingsItem",
  });
  return r.status === "ACCEPTED" ? { result: "precio ajustado", from: current, to: target, ...fix } : { result: "rechazada", detail: JSON.stringify(r.issues ?? r.status) };
}

async function main() {
  const now = new Date().toISOString();
  const listings = esFbaListingsFromCatalog(fs.readFileSync(CATALOG, "utf-8"));
  if (!listings.length) throw new Error(`Sin listings FBA en ${CATALOG}; no se fija la línea base con un catálogo vacío.`);
  const previous = await readJson<ReplicationState>(STATE_KEY);
  const { state, work } = planRun(previous, listings, now);
  const report: any[] = [];

  for (const item of work) {
    try {
      const es = await getListing(item.sku, ES);
      const esPrice = ourPrice(es, ES);
      if (!es || esPrice == null) {
        if (item.manage.length) report.push({ sku: item.sku, result: "sin precio en ES" });
        continue;
      }
      // Un FBA de la línea base que no se vende en ES no se replica.
      const createOnly = (es.summaries?.[0]?.status ?? []).includes("BUYABLE") ? item.createOnly : [];
      for (const code of [...item.manage, ...createOnly]) {
        const mid = EU_MARKETPLACES[code].id;
        const target = targetPriceForSku(esPrice, item.sku, code);
        const existing = await getListing(item.sku, mid);
        const managed = item.manage.includes(code);
        const outcome = !existing
          ? await createOffer(item.sku, item.asin, code, es, target)
          : managed ? await syncPrice(item.sku, code, existing, target) : { result: "existe (no gestionada)" };
        if (outcome.result === "creada") state.managed[managedKey(item.sku, code)] = { origin: "created", since: now };
        if (outcome.result !== "ok" && outcome.result !== "existe (no gestionada)") report.push({ sku: item.sku, pais: code, precio_es: esPrice, objetivo: target, ...outcome });
      }
    } catch (e) {
      report.push({ sku: item.sku, result: "error", detail: String(e).slice(0, 200) });
    }
  }

  const summary: Record<string, number> = {};
  for (const r of report) summary[r.result] = (summary[r.result] ?? 0) + 1;
  await writeJson(STATE_KEY, state);
  await writeJson(REPORT_KEY, { at: now, apply: APPLY, firstRun: !previous, baseline: state.baseline.length, managed: Object.keys(state.managed).length, revisados: work.length, summary, items: report });
  console.log(`FBA replication ${APPLY ? "APPLY" : "DRY-RUN"} | línea base ${state.baseline.length}${previous ? "" : " (nueva)"} | gestionadas ${Object.keys(state.managed).length} | revisados ${work.length} | ${JSON.stringify(summary)}`);
  for (const r of report) console.log(" ", JSON.stringify(r));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
