import assert from "node:assert/strict";
import test from "node:test";
import { PricingService } from "../../src/modules/pricing/pricing.service";
import type { SpApiClient } from "../../src/spapi/client";
import { publishPricingSnapshots } from "./publish-pricing";

test("seller IDs, profile links, own offers and missing IDs", async () => {
  const client = { request: async () => ({ payload: { Offers: [
    { SellerId: "OTHER", ListingPrice: { Amount: 12 }, Shipping: { Amount: 2 } },
    { SellerId: "OWN", IsBuyBoxWinner: true, ListingPrice: { Amount: 11 } },
    { MyOffer: true, ListingPrice: { Amount: 15 } },
  ] } }) } as unknown as SpApiClient;
  const { offers } = await new PricingService(client, "A1RKKUPIHCS9HS", "OWN").getProductOffersDetail("B012345678");
  assert.equal(offers[0].sellerId, "OWN");
  assert.equal(offers[0].isMyOffer, true);
  assert.equal(new URL(offers[1].sellerUrl!).searchParams.get("seller"), "OTHER");
  assert.equal(offers[1].totalPrice, 14);
  assert.equal(offers[1].isMyOffer, false);
  assert.equal(offers[2].sellerId, null);
  assert.equal(offers[2].sellerUrl, null);
  assert.equal(offers[2].isMyOffer, true);
});

test("publishes details for every selectable product", async () => {
  const writes: string[] = [];
  const count = await publishPricingSnapshots(async (path) => path.includes("summary")
    ? { products: [{ asin: "B012345678" }, { asin: "B987654321" }] }
    : { offers: [{ sellerId: "SELLER" }] }, async (key) => { writes.push(key); });
  assert.equal(count, 3);
  assert.deepEqual(writes, ["pricing:summary", "pricing:offers:B012345678", "pricing:offers:B987654321"]);
});

test("failed details are reported without stopping other products", async () => {
  const writes: string[] = [];
  await assert.rejects(publishPricingSnapshots(async (path) => {
    if (path.includes("summary")) return { products: [{ asin: "broken" }, { asin: "good" }] };
    if (path.includes("broken")) throw new Error("Amazon unavailable");
    return { offers: [] };
  }, async (key) => { writes.push(key); }), /broken: Amazon unavailable/);
  assert.deepEqual(writes, ["pricing:summary", "pricing:offers:good"]);
});

test("skips ASINs missing from the selected marketplace without failing the sync", async () => {
  const writes: string[] = [];
  const count = await publishPricingSnapshots(async (path) => {
    if (path.includes("summary")) return { products: [{ asin: "missing" }, { asin: "good" }] };
    if (path.includes("missing")) throw new Error("Requested item, B08ZG1T4P5, not found in marketplace(s) A1RKKUPIHCS9HS.");
    return { offers: [] };
  }, async (key) => { writes.push(key); });
  assert.equal(count, 2);
  assert.deepEqual(writes, ["pricing:summary", "pricing:offers:good"]);
});
