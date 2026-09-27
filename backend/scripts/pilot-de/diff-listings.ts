import fs from "node:fs";
import { SpApiClient } from "../../src/spapi/client";
import { env } from "../../src/config/env";
import { createReport, getReport, getReportDocument, downloadReportDocument } from "../../src/spapi/endpoints/reports";
import { sleep } from "../../src/spapi/rateLimiter";

const client = new SpApiClient({ credentials: env.spApi });
async function listings(mid: string): Promise<Record<string, string>[]> {
  const { reportId } = await createReport(client, { reportType: "GET_MERCHANT_LISTINGS_ALL_DATA", marketplaceIds: [mid] });
  for (let i = 0; i < 100; i++) {
    await sleep(5000);
    const s = await getReport(client, reportId);
    if (s.processingStatus === "DONE") {
      const txt = (await downloadReportDocument(await getReportDocument(client, s.reportDocumentId!))).toString("latin1");
      const [head, ...rest] = txt.split(/\r?\n/).filter(Boolean);
      const h = head.split("\t");
      return rest.map((l) => Object.fromEntries(l.split("\t").map((v, i) => [h[i], v])));
    }
    if (s.processingStatus !== "IN_QUEUE" && s.processingStatus !== "IN_PROGRESS") throw new Error(`${mid} ${s.processingStatus}`);
  }
  throw new Error("timeout");
}
const es = await listings("A1RKKUPIHCS9HS");
const de = await listings("A1PA6795UKMFR9");
console.log("cols:", Object.keys(es[0]).join(" | "));
const deSkus = new Set(de.map((r) => r["seller-sku"]));
const missing = es.filter((r) => !deSkus.has(r["seller-sku"]) && !r["seller-sku"].startsWith("amzn.gr."));
const active = missing.filter((r) => (r["status"] ?? "").toLowerCase() === "active");
console.log(`ES listings: ${es.length} | DE listings: ${de.length} | faltan en DE: ${missing.length} (activos en ES: ${active.length})`);
fs.writeFileSync("scripts/pilot-de/missing-de.json", JSON.stringify(active, null, 1));
for (const r of active.slice(0, 15)) console.log(r["seller-sku"], r["asin1"], r["price"], r["quantity"], r["fulfillment-channel"], (r["item-name"] ?? "").slice(0, 55));
process.exit(0);
