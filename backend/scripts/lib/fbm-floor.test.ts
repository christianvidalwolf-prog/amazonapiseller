import assert from "node:assert/strict";
import test from "node:test";
import { decide, fixedPriceKeys, floorPrice, pairsFromCatalog } from "./fbm-floor";

test("pares FBM/FBA por ASIN, sin amzn.gr ni ASIN de un solo canal", () => {
  const csv = [
    "﻿item-name;seller-sku;asin1;fulfillment-channel",
    "Felpudo;2857149CLM;B0F1TGJ3LT;DEFAULT",
    "Felpudo;2857149CLMFBA;B0F1TGJ3LT;AMAZON_EU",
    "Felpudo usado;amzn.gr.2857149CLM-x;B0F1TGJ3LT;AMAZON_EU",
    "Solo FBM;111VC;B000000001;DEFAULT",
  ].join("\n");
  assert.deepEqual(pairsFromCatalog(csv), [{ asin: "B0F1TGJ3LT", fbm: ["2857149CLM"], fba: ["2857149CLMFBA"] }]);
});

test("mínimo = FBA más cara × 1,05, redondeado a céntimos", () => {
  assert.equal(floorPrice([25.99]), 27.29);
  assert.equal(floorPrice([19.99, 24]), 25.2);
  assert.equal(floorPrice([]), null);
});

test("decisión: subir, dejar, o saltar por precio fijo, oferta vigente o sin FBA", () => {
  const fixed = fixedPriceKeys("sku;pais;precio\n309287DCI;ES;19.99\n");
  const o = (sku: string, price: number | null, sale: number | null = null) => ({ sku, country: "ES" as const, price, sale });
  assert.deepEqual(decide(o("2857149CLM", 23.15), 27.29, fixed), { action: "raise", floor: 27.29, from: 23.15 });
  assert.deepEqual(decide(o("2857149CLM", 28), 27.29, fixed), { action: "ok", floor: 27.29 });
  assert.equal(decide(o("309287DCI", 16.4), 30, fixed).action, "skip");
  assert.equal(decide(o("X", 10, 9), 12, fixed).action, "skip");
  assert.equal(decide(o("X", 10), null, fixed).action, "skip");
});
