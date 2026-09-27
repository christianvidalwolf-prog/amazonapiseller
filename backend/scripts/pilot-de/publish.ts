import fs from "node:fs";
import { SpApiClient } from "../../src/spapi/client";
import { env } from "../../src/config/env";
import { previewListingsItem, putListingsItem } from "../../src/spapi/endpoints/listingsItems";
const DE = "A1PA6795UKMFR9";
const SKUS = ["11382SGI", "11934VC", "1673SGI", "14572VCI"];
const client = new SpApiClient({ credentials: env.spApi });
const payloads = JSON.parse(fs.readFileSync("scripts/pilot-de/payloads-de.json", "utf-8"));
const log: unknown[] = [];
for (const sku of SKUS) {
  const params = { sellerId: env.sellerId, sku, marketplaceIds: [DE] };
  const check = await previewListingsItem(client, params, payloads[sku]);
  if (check.status !== "VALID") { console.log(`SKIP ${sku}: validation ${check.status}`); continue; }
  const res = await putListingsItem(client, params, payloads[sku]);
  const errs = (res.issues ?? []).filter((i) => i.severity === "ERROR");
  console.log(`${sku}: ${res.status} submissionId=${res.submissionId} errors=${errs.length}`);
  for (const i of errs) console.log(`  ${i.code} ${i.message.slice(0, 200)}`);
  log.push({ sku, at: new Date().toISOString(), ...res });
}
fs.writeFileSync("scripts/pilot-de/publish-log.json", JSON.stringify(log, null, 1));
process.exit(0);
