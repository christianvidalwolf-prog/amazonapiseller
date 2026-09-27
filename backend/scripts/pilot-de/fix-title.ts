import fs from "node:fs";
import { SpApiClient } from "../../src/spapi/client";
import { env } from "../../src/config/env";
import { patchListingsItem } from "../../src/spapi/endpoints/listingsItems";
const DE = "A1PA6795UKMFR9";
const title = "Räucherbündel Myrrhe Palo Santo, handgebunden aus Zeder, Lorbeer und Eukalyptus, Räuchern und Meditation, 1 Stück, Brenndauer 2 Stunden";
const client = new SpApiClient({ credentials: env.spApi });
const res = await patchListingsItem(client, { sellerId: env.sellerId, sku: "14572VCI", marketplaceIds: [DE] }, {
  productType: "INCENSE",
  patches: [{ op: "replace", path: "/attributes/item_name", value: [{ value: title, language_tag: "de_DE", marketplace_id: DE }] }],
});
console.log(title.length, res.status, res.submissionId, JSON.stringify(res.issues ?? []));
const p = JSON.parse(fs.readFileSync("scripts/pilot-de/payloads-de.json", "utf-8"));
p["14572VCI"].attributes.item_name[0].value = title;
fs.writeFileSync("scripts/pilot-de/payloads-de.json", JSON.stringify(p, null, 1));
process.exit(0);
