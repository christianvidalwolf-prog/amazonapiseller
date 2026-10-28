/**
 * Vigilante FBA: cada mañana busca en ES/DE/FR/IT los SKU con unidades vendibles en almacenes de Amazon
 * (FBA Inventory, fulfillableQuantity > 0) cuyo listing no está a la venta (estado sin BUYABLE), con el
 * motivo que da Amazon (issues ERROR). Solo lee de Amazon; no cambia nada.
 *
 * Si encuentra alguno envía un email desde Gmail (SMTP con contraseña de aplicación); si no, no envía nada.
 * Resultado también en el log del run y en Supabase. Env:
 *   GMAIL_USER / GMAIL_APP_PASSWORD → cuenta que envía; sin ellas solo informa por consola.
 *   ALERT_EMAIL_TO        → destinatario (por defecto christianvidalwolf@gmail.com).
 *   FBA_WATCH_COUNTRIES   → países separados por comas (por defecto ES,DE,FR,IT).
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY → informe en snapshots (alerts:fba-inactive:last-run).
 *   FBA_WATCH_IGNORE_FILE → casos que no se avisan (por defecto ../fba_watch_ignore.txt); salen como "ignorados" en el informe.
 */
import fs from "node:fs";
import path from "node:path";
import { env } from "../src/config/env";
import { EU_MARKETPLACES } from "../src/modules/account-health/account-health.service";
import { SpApiClient } from "../src/spapi/client";
import { getInventorySummaries } from "../src/spapi/endpoints/fbaInventory";
import { getListingsItem } from "../src/spapi/endpoints/listingsItems";
import nodemailer from "nodemailer";
import { alertHtml, alertSubject, inactiveReasons, isGradeAndResell, isIgnored, parseIgnoreRules, type InactiveListing, type ListingIssue } from "./lib/fba-watch";

const REPORT_KEY = "alerts:fba-inactive:last-run";
const COUNTRIES = (process.env.FBA_WATCH_COUNTRIES ?? "ES,DE,FR,IT").split(",").map((c) => c.trim().toUpperCase()).filter((c) => EU_MARKETPLACES[c]);
/** Motivos en español en todos los países. */
const ISSUE_LOCALE = "es_ES";

const IGNORE_FILE = process.env.FBA_WATCH_IGNORE_FILE ?? path.resolve(process.cwd(), "..", "fba_watch_ignore.txt");
const ignoreRules = fs.existsSync(IGNORE_FILE) ? parseIgnoreRules(fs.readFileSync(IGNORE_FILE, "utf-8")) : [];

const EMAIL_TO = process.env.ALERT_EMAIL_TO?.trim() || "christianvidalwolf@gmail.com";

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

async function sendEmail(subject: string, html: string): Promise<string> {
  const user = process.env.GMAIL_USER?.trim();
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
  if (!user || !pass) return "sin GMAIL_USER/GMAIL_APP_PASSWORD: email no enviado";
  const transport = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } });
  const info = await transport.sendMail({ from: `Vigilante FBA <${user}>`, to: EMAIL_TO, subject, html });
  return `email enviado a ${EMAIL_TO} (${info.messageId})`;
}

const client = new SpApiClient({ credentials: env.spApi });
const isNotFound = (e: unknown) => /NOT_FOUND|not found/i.test(String(e));

/** SKU → unidades vendibles en los almacenes que sirven a un marketplace. */
async function fbaStock(marketplaceId: string): Promise<Map<string, { asin: string; units: number }>> {
  const stock = new Map<string, { asin: string; units: number }>();
  let nextToken: string | undefined;
  do {
    const page = await getInventorySummaries(client, { marketplaceIds: [marketplaceId], nextToken });
    for (const s of page.payload?.inventorySummaries ?? []) {
      const units = s.inventoryDetails?.fulfillableQuantity ?? 0;
      if (units > 0) stock.set(s.sellerSku, { asin: s.asin, units });
    }
    nextToken = page.pagination?.nextToken;
  } while (nextToken);
  return stock;
}

async function checkListing(sku: string, code: string, stock: { asin: string; units: number }): Promise<InactiveListing | null> {
  let listing: any = null;
  try {
    listing = await getListingsItem(client, { sellerId: env.sellerId, sku, marketplaceIds: [EU_MARKETPLACES[code].id], includedData: ["summaries", "issues"], issueLocale: ISSUE_LOCALE });
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  const summary = listing?.summaries?.[0];
  const status: string[] = summary?.status ?? [];
  // Los amzn.gr.* (devoluciones que Amazon revende como usadas) solo existen donde Amazon los crea:
  // que falten en otro país no es un problema que se pueda arreglar.
  if (!summary && isGradeAndResell(sku)) return null;
  const reasons = listing ? inactiveReasons(status, (listing.issues ?? []) as ListingIssue[]) : ["El SKU no existe en este marketplace"];
  if (!reasons) return null;
  return { sku, pais: code, asin: summary?.asin ?? stock.asin ?? null, unidades: stock.units, estado: status, motivos: reasons };
}

async function main() {
  const now = new Date();
  const inactive: InactiveListing[] = [];
  const ignored: InactiveListing[] = [];
  const errors: Array<{ pais: string; sku?: string; detail: string }> = [];
  const conStock: Record<string, number> = {};

  for (const code of COUNTRIES) {
    let stock: Map<string, { asin: string; units: number }>;
    try {
      stock = await fbaStock(EU_MARKETPLACES[code].id);
    } catch (e) {
      errors.push({ pais: code, detail: `inventario FBA: ${String(e).slice(0, 200)}` });
      continue;
    }
    conStock[code] = stock.size;
    for (const [sku, s] of stock) {
      try {
        const row = await checkListing(sku, code, s);
        if (row) (isIgnored(row, ignoreRules) ? ignored : inactive).push(row);
      } catch (e) {
        errors.push({ pais: code, sku, detail: String(e).slice(0, 200) });
      }
    }
  }

  let email = "sin incidencias: email no enviado";
  let emailFailed = false;
  if (inactive.length) {
    try {
      email = await sendEmail(alertSubject(inactive), alertHtml(inactive, now.toISOString().slice(0, 10)));
    } catch (e) {
      email = `error al enviar el email: ${String(e).slice(0, 300)}`;
      emailFailed = true;
    }
  }
  await writeReport({ at: now.toISOString(), paises: COUNTRIES, con_stock: conStock, inactivos: inactive.length, ignorados: ignored, email, errores: errors, items: inactive });
  console.log(`Vigilante FBA | con stock ${JSON.stringify(conStock)} | inactivos ${inactive.length} | ignorados ${ignored.length} | errores ${errors.length} | ${email}`);
  for (const r of inactive) console.log(" ", JSON.stringify(r));
  for (const e of errors) console.log("  ERROR", JSON.stringify(e));
  if (emailFailed || (errors.length && !inactive.length && !Object.keys(conStock).length)) process.exit(1);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
