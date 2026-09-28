import assert from "node:assert/strict";
import test from "node:test";
import {
  addSales,
  archiveRecord,
  catalogCandidates,
  keepReason,
  parseOpenDate,
  parseStockFile,
  reactivationPayload,
  reactivationPrice,
  stockFromSnapshotItems,
} from "./listing-cleanup";

const CATALOG = [
  "﻿item-name;seller-sku;price;quantity;open-date;asin1;fulfillment-channel;status",
  "Viejo sin ventas;OLD1;9.95;0;20/06/2015 10:00:00 MEST;B001;DEFAULT;Inactive",
  "Viejo con stock;OLD2;9.95;5;20/06/2015 10:00:00 MEST;B002;DEFAULT;Active",
  "Vendido por otro SKU del ASIN;OLD3;9.95;0;01/01/2020 10:00:00 MET;B003;DEFAULT;Inactive",
  "Nuevo;NEW1;9.95;0;02/01/2025 10:00:00 MET;B004;DEFAULT;Inactive",
  "Usado Amazon;amzn.gr.OLD1-x;5;;01/01/2020 10:00:00 MET;B001;AMAZON_EU;Active",
  "Viejo FBA;OLD4FBA;12;;01/03/2024 10:00:00 MET;B005;AMAZON_EU;Inactive",
].join("\n");

const SALES = "amazon-order-id;order-status;sku;asin;quantity\n1;Shipped;OTHER3;B003;1\n2;Cancelled;OLD1;B001;1\n";

test("open-date del catálogo a ISO", () => {
  assert.equal(parseOpenDate("02/09/2026 16:07:58 MEST"), "2026-09-02");
  assert.equal(parseOpenDate(""), null);
});

test("candidatos: ≤ año máximo, sin ventas del SKU ni del ASIN, sin stock FBM, sin amzn.gr", () => {
  const sales = addSales({ skus: new Set(), asins: new Set() }, SALES);
  const c = catalogCandidates(CATALOG, sales, 2024);
  assert.deepEqual(c.map((x) => x.sku), ["OLD1", "OLD4FBA"]);
  assert.equal(c[0].channel, "FBM");
  assert.equal(c[1].channel, "FBA");
});

const listing = (over: any = {}) => ({
  summaries: [{ marketplaceId: "A1RKKUPIHCS9HS", productType: "KITCHEN", status: ["DISCOVERABLE"] }],
  fulfillmentAvailability: [{ fulfillmentChannelCode: "DEFAULT", quantity: 0 }],
  relationships: [],
  attributes: {},
  ...over,
});

test("se mantiene si es padre, tiene stock, inventario FBA o se puede comprar", () => {
  assert.equal(keepReason(listing(), 0), null);
  assert.equal(keepReason(null, 0), "no existe en Amazon");
  assert.equal(keepReason(listing({ attributes: { parentage_level: [{ value: "parent" }] } }), 0), "padre de variación");
  assert.equal(keepReason(listing({ relationships: [{ marketplaceId: "x", relationships: [{ type: "VARIATION", childSkus: ["C1"] }] }] }), 0), "padre de variación");
  assert.equal(keepReason(listing({ fulfillmentAvailability: [{ fulfillmentChannelCode: "DEFAULT", quantity: 3 }] }), 0), "stock FBM 3");
  assert.equal(keepReason(listing(), 2), "inventario FBA 2");
  assert.equal(keepReason(listing({ summaries: [{ marketplaceId: "A1PA6795UKMFR9", status: ["BUYABLE"] }] }), 0), "se puede comprar en algún marketplace");
});

const ES = "A1RKKUPIHCS9HS", DE = "A1PA6795UKMFR9";
const archived = archiveRecord(
  { sku: "OLD1", asin: "B001", openDate: "2015-06-20", channel: "FBM", catalogStatus: "Inactive", catalogQuantity: 0, price: "9.95", name: "Viejo" },
  listing({
    summaries: [
      { marketplaceId: ES, productType: "KITCHEN", status: ["DISCOVERABLE"] },
      { marketplaceId: DE, productType: "KITCHEN", status: [] },
    ],
    attributes: {
      bullet_point: [{ value: "texto largo", marketplace_id: ES }],
      condition_type: [{ value: "new_new", marketplace_id: ES }],
      merchant_shipping_group: [{ value: "legacy-template-id", marketplace_id: ES }],
      purchasable_offer: [
        { audience: "ALL", marketplace_id: ES, currency: "EUR", our_price: [{ schedule: [{ value_with_tax: 9.95 }] }] },
        { audience: "ALL", marketplace_id: DE, currency: "EUR", our_price: [{ schedule: [{ value_with_tax: 14.95 }] }] },
      ],
    },
  }),
  "2026-09-28T00:00:00Z",
);

test("el archivo guarda marketplaces, precios y atributos de oferta, no el contenido de la ficha", () => {
  assert.deepEqual(archived.marketplaces.map((m) => [m.code, m.price]), [["ES", 9.95], ["DE", 14.95]]);
  assert.equal(archived.attributes.bullet_point, undefined);
  assert.ok(archived.attributes.merchant_shipping_group);
  assert.equal(archived.status, "archived");
});

test("payload de reactivación: oferta sobre el ASIN, con plantilla de envío y stock FBM", () => {
  const p = reactivationPayload(archived, "DE", 17.5, 12);
  assert.equal(p.requirements, "LISTING_OFFER_ONLY");
  assert.equal(p.productType, "KITCHEN");
  assert.deepEqual(p.attributes.merchant_suggested_asin, [{ value: "B001", marketplace_id: DE }]);
  assert.equal(p.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax, 17.5);
  assert.deepEqual(p.attributes.fulfillment_availability[0], { fulfillment_channel_code: "DEFAULT", quantity: 12, lead_time_to_ship_max_days: 2, marketplace_id: DE });
  // La plantilla de envío de un país no se copia a otro: sin la suya, DE usa la plantilla por defecto.
  assert.deepEqual(p.attributes.merchant_shipping_group, undefined);
  const es = reactivationPayload(archived, "ES", 9.95, 1);
  assert.deepEqual(es.attributes.merchant_shipping_group, [{ value: "legacy-template-id", marketplace_id: ES }]);
});

test("fichero de stock (tabulador, coma decimal) y precio de reactivación con recargo por país", () => {
  const stock = parseStockFile("sku\tprice\tminimum-seller-allowed-price\tmaximum-seller-allowed-price\tquantity\r\nOLD1\t10,5\t5\t21\t7\r\n");
  assert.deepEqual(stock.get("OLD1"), { sku: "OLD1", price: 10.5, quantity: 7 });
  assert.equal(reactivationPrice(archived, "ES", stock.get("OLD1")), 10.5);
  assert.equal(reactivationPrice(archived, "DE", stock.get("OLD1")), 15.5);
  assert.equal(reactivationPrice(archived, "DE"), 14.95);
});

test("copia de stock de Supabase: precio base y cantidad por SKU, sin precio si falta o es 0", () => {
  const stock = stockFromSnapshotItems([
    { sku: "OLD1", quantity: 7, price: 10.5, min_price: 5.25, max_price: 21, lead_time: 2 },
    { sku: "OLD2", quantity: "3", price: null },
    { sku: "OLD3", quantity: 0, price: 0 },
    { sku: "", quantity: 9, price: 1 },
  ]);
  assert.deepEqual([...stock.keys()], ["OLD1", "OLD2", "OLD3"]);
  assert.deepEqual(stock.get("OLD1"), { sku: "OLD1", price: 10.5, quantity: 7 });
  assert.equal(stock.get("OLD2")?.price, null);
  assert.equal(stock.get("OLD2")?.quantity, 3);
  assert.equal(stock.get("OLD3")?.price, null);
  assert.equal(reactivationPrice(archived, "FR", stock.get("OLD1")), 16.5);
});
