import { describe, expect, it } from "vitest";
import {
  activeSalePrice,
  blockedSkusFromText,
  currentShippingGroup,
  DE_MARKETPLACE_ID,
  decideRow,
  effectivePrice,
  emptyOverrides,
  FREE_SHIPPING_GROUP,
  FREE_SHIPPING_LABEL,
  isFreeShippingGroup,
  liveDecision,
  liveEffectivePrice,
  liveFulfillmentChannel,
  liveRow,
  listingProductType,
  overrideKey,
  PAID_SHIPPING_GROUP,
  PAID_SHIPPING_LABEL,
  parseAmount,
  parseDeReportTsv,
  parseLimit,
  parseSalesSnapshot,
  PRICE_LIMIT,
  priceBucket,
  shippingGroupKind,
  shippingGroupPatch,
  shippingGroupTemplate,
  skuFamily,
  stateIsFresh,
  summarize,
  type DeReportRow,
  type PriceOverrides,
} from "./de-shipping-group";

const NOW = new Date("2026-11-04T10:00:00Z");

/** Fila del informe de un FBM barato en la plantilla de ENVÍO GRATIS (el caso que hay que corregir). */
const row = (over: Partial<DeReportRow> = {}): DeReportRow => ({
  sku: "2857149CLM",
  asin: "B0F1TGJ3LT",
  price: 24.99,
  quantity: 10,
  status: "Active",
  channel: "DEFAULT",
  group: FREE_SHIPPING_LABEL,
  ...over,
});

const overrides = (over: Partial<PriceOverrides> = {}): PriceOverrides => ({ ...emptyOverrides(), ...over });

describe("las dos plantillas", () => {
  it("el destino es legacy-template-id (PAGO, 3,99 €), no el UUID (GRATIS, 0,00 €)", () => {
    expect(PAID_SHIPPING_GROUP).toBe("legacy-template-id");
    expect(FREE_SHIPPING_GROUP).toBe("395e11ea-3c51-4820-aa8f-74e6cf2a4e72");
    expect(PAID_SHIPPING_LABEL).toBe("GRUPO 0");
    expect(FREE_SHIPPING_LABEL).toBe("GRUPO 4");
  });

  it("clasifica el valor del atributo y la etiqueta del informe", () => {
    expect(shippingGroupKind(FREE_SHIPPING_GROUP)).toBe("gratis");
    expect(shippingGroupKind("GRUPO 4")).toBe("gratis");
    expect(shippingGroupKind(PAID_SHIPPING_GROUP)).toBe("pago");
    expect(shippingGroupKind("GRUPO 0")).toBe("pago");
    expect(shippingGroupKind("")).toBe("sin atributo");
    expect(shippingGroupKind(null)).toBe("sin atributo");
    expect(shippingGroupKind("otro-uuid-cualquiera")).toBe("otra");
    expect(isFreeShippingGroup(FREE_SHIPPING_GROUP)).toBe(true);
    expect(isFreeShippingGroup(PAID_SHIPPING_GROUP)).toBe(false);
    expect(isFreeShippingGroup(undefined)).toBe(false);
  });

  it("traduce la etiqueta del informe al identificador de la plantilla", () => {
    expect(shippingGroupTemplate("GRUPO 4")).toBe(FREE_SHIPPING_GROUP);
    expect(shippingGroupTemplate("GRUPO 0")).toBe(PAID_SHIPPING_GROUP);
    expect(shippingGroupTemplate("")).toBe(PAID_SHIPPING_GROUP);
    expect(shippingGroupTemplate("otro-uuid-cualquiera")).toBe("otro-uuid-cualquiera");
  });
});

describe("parseAmount", () => {
  it("lee los formatos que puede traer el informe", () => {
    expect(parseAmount("42.5")).toBe(42.5);
    expect(parseAmount(" 16,95 ")).toBe(16.95);
    expect(parseAmount("1.234,56")).toBe(1234.56);
    expect(parseAmount("1,234.56")).toBe(1234.56);
    expect(parseAmount("29,95 €")).toBe(29.95);
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
  });
});

describe("parseDeReportTsv", () => {
  const tsv = [
    "\uFEFFitem-name\tseller-sku\tprice\tquantity\tstatus\tasin1\tfulfillment-channel\tmerchant-shipping-group",
    "Felpudo\t2857149CLM\t24,99\t10\tActive\tB0F1TGJ3LT\tDEFAULT\tGRUPO 4",
    "Felpudo FBA\t2857149CLMFBA\t42.50\t0\tInactive\tB0F1TGJ3LT\tAMAZON_EU\tGRUPO 0",
    "Sin precio\t10006VC\t\t3\tIncomplete\tB0B9D92L51\tDEFAULT\tGRUPO 4",
  ].join("\n");

  it("normaliza las columnas que usa la regla y aguanta el BOM y los importes con coma", () => {
    const rows = parseDeReportTsv(tsv);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ sku: "2857149CLM", asin: "B0F1TGJ3LT", price: 24.99, channel: "DEFAULT", group: "GRUPO 4" });
    expect(rows[1]).toMatchObject({ sku: "2857149CLMFBA", price: 42.5, channel: "AMAZON_EU", group: "GRUPO 0" });
    expect(rows[2].price).toBeNull();
  });

  it("falla si faltan columnas del informe", () => {
    expect(() => parseDeReportTsv("item-name\tseller-sku\nx\t1\n")).toThrow(/columnas/);
  });

  it("una fila cortada (menos columnas que la cabecera) no rompe ni inventa precios", () => {
    const cortada = [
      "item-name\tseller-sku\tprice\tquantity\tstatus\tasin1\tfulfillment-channel\tmerchant-shipping-group",
      "Felpudo\t2857149CLM",
      "  Con espacios  \t 10000VCT \t29,95\t1\tActive\tB0B9D92L51\tDEFAULT\tGRUPO 4",
    ].join("\n");
    const rows = parseDeReportTsv(cortada);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ sku: "2857149CLM", price: null, channel: "", group: "" });
    // El SKU con espacios alrededor se recorta; decideRow lo usa tal cual para el GET y el PATCH.
    expect(rows[1]).toMatchObject({ sku: "10000VCT", price: 29.95, group: "GRUPO 4" });
  });
});

describe("parseLimit (tope por ejecución)", () => {
  it("usa el valor cuando es un entero ≥ 1 y el de por defecto cuando no viene", () => {
    expect(parseLimit("25")).toBe(25);
    expect(parseLimit(" 250 ")).toBe(250);
    expect(parseLimit(undefined)).toBe(5000);
    expect(parseLimit("")).toBe(5000);
  });

  it("aborta en vez de convertirse en 0 o en un recorte raro", () => {
    for (const raw of ["abc", "0", "-25", "12.5", "NaN"]) {
      expect(() => parseLimit(raw)).toThrow(/SHIPPING_GROUP_LIMIT/);
    }
  });
});

describe("estado local (reanudabilidad)", () => {
  const at = (iso: string) => ({ status: "ok", at: iso });
  const now = new Date("2026-11-04T10:00:00Z");

  it("un `ok` reciente evita repetir el SKU; uno caducado vuelve a entrar", () => {
    expect(stateIsFresh(at("2026-11-01T10:00:00Z"), now, 30)).toBe(true);
    expect(stateIsFresh(at("2026-09-01T10:00:00Z"), now, 30)).toBe(false);
    expect(stateIsFresh(undefined, now, 30)).toBe(false);
  });

  it("los `err` se reintentan siempre y un `at` ilegible no bloquea el SKU", () => {
    expect(stateIsFresh({ status: "err", at: "2026-11-04T09:59:00Z" }, now, 30)).toBe(false);
    expect(stateIsFresh({ status: "ok", at: "no-es-fecha" }, now, 30)).toBe(false);
  });

  it("ttl 0 conserva el comportamiento antiguo: el `ok` no caduca", () => {
    expect(stateIsFresh(at("2020-01-01T00:00:00Z"), now, 0)).toBe(true);
    expect(stateIsFresh(undefined, now, 0)).toBe(false);
  });
});

describe("skuFamily", () => {
  it("agrupa por el sufijo alfabético, sin el marcador FBA", () => {
    expect(skuFamily("27761203DCI")).toBe("DCI");
    expect(skuFamily("10000VCT")).toBe("VCT");
    expect(skuFamily("2857149CLM")).toBe("CLM");
    expect(skuFamily("2684319CLMFBA")).toBe("CLM");
    expect(skuFamily("1007VCFBA")).toBe("VC");
    expect(skuFamily("24350SG")).toBe("SG");
    expect(skuFamily("10000FBA")).toBe("FBA");
    expect(skuFamily("2857149")).toBe("sin sufijo");
  });
});

describe("blockedSkusFromText", () => {
  it("ignora comentarios y vacías, y normaliza a mayúsculas", () => {
    expect([...blockedSkusFromText("# retirados\n24350sg\n\n 24348SG \n")]).toEqual(["24350SG", "24348SG"]);
  });
});

describe("overrides de precio", () => {
  it("rules:sales: se queda con DE y descarta las caducadas", () => {
    const sales = parseSalesSnapshot({
      sales: {
        "2857149CLM": { DE: { price: 19.99, start: "2026-10-01T00:00:00Z", end: "2026-11-30T00:00:00Z" }, ES: { price: 18, start: "2026-10-01T00:00:00Z", end: "2026-11-30T00:00:00Z" } },
        "10000VCT": { DE: { price: 9.99, start: "2026-10-01T00:00:00Z", end: "2026-10-20T00:00:00Z" } },
      },
    });
    expect(sales.get(overrideKey("2857149CLM"))?.price).toBe(19.99);
    expect(activeSalePrice(sales.get(overrideKey("2857149CLM")), NOW)).toBe(19.99);
    // Caducada: no cuenta como precio efectivo.
    expect(activeSalePrice(sales.get(overrideKey("10000VCT")), NOW)).toBeNull();
    expect(sales.get(overrideKey("10000VCT"))?.price).toBe(9.99);
  });

  it("precio manual > precio fijo > informe; la oferta registrada manda sobre todos", () => {
    const ov = overrides({
      fixed: new Map([["2857149CLM|DE", 30]]),
      manual: new Map([["2857149CLM|DE", 28]]),
    });
    expect(effectivePrice("2857149CLM", 45, ov, NOW)).toEqual({ price: 28, source: "precio manual" });
    expect(effectivePrice("10000VCT", 45, ov, NOW)).toEqual({ price: 45, source: "informe" });
    const withSale = overrides({ fixed: new Map([["2857149CLM|DE", 30]]), sales: new Map([["2857149CLM|DE", { price: 21.5, start: "2026-11-01T00:00:00Z", end: "2026-12-01T00:00:00Z" }]]) });
    expect(effectivePrice("2857149CLM", 45, withSale, NOW)).toEqual({ price: 21.5, source: "oferta registrada" });
  });
});

describe("decideRow", () => {
  it("bordes 34,99 / 35,00 / 35,01 en la plantilla de envío gratis", () => {
    expect(decideRow(row({ price: 34.99 }), emptyOverrides(), { now: NOW })).toMatchObject({
      action: "mover",
      motivo: "precio efectivo < 35 €",
      plantillaOrigen: FREE_SHIPPING_GROUP,
      plantillaDestino: PAID_SHIPPING_GROUP,
    });
    expect(decideRow(row({ price: PRICE_LIMIT }), emptyOverrides(), { now: NOW })).toMatchObject({ action: "ok", motivo: "precio efectivo ≥ 35 €", plantillaDestino: "" });
    expect(decideRow(row({ price: 35.01 }), emptyOverrides(), { now: NOW })).toMatchObject({ action: "ok", motivo: "precio efectivo ≥ 35 €" });
  });

  it("los que ya están en la plantilla de pago (GRUPO 0) no se tocan, ni con precio 5 €", () => {
    expect(decideRow(row({ group: PAID_SHIPPING_LABEL, price: 5 }), emptyOverrides(), { now: NOW })).toMatchObject({
      action: "ok",
      motivo: "ya en plantilla de pago (GRUPO 0)",
    });
  });

  it("FBA no se toca nunca, ni con precio 5 €", () => {
    const d = decideRow(row({ channel: "AMAZON_EU", price: 5 }), emptyOverrides(), { now: NOW });
    expect(d.action).toBe("ok");
    expect(d.motivo).toBe("FBA (AMAZON_EU)");
  });

  it("una plantilla que no es ninguna de las dos no se toca y se marca", () => {
    expect(decideRow(row({ group: "otro-uuid-cualquiera", price: 12 }), emptyOverrides(), { now: NOW })).toMatchObject({
      action: "ok",
      motivo: "otra plantilla (no es la de envío gratis)",
    });
  });

  it("SKU de blocked_skus.txt se omite", () => {
    const blocked = blockedSkusFromText("24350SG\n");
    expect(decideRow(row({ sku: "24350SG", price: 12 }), emptyOverrides(), { blocked, now: NOW })).toMatchObject({
      action: "omitir",
      motivo: "SKU retirado (blocked_skus.txt)",
    });
  });

  it("sin precio se omite", () => {
    expect(decideRow(row({ price: null }), emptyOverrides(), { now: NOW })).toMatchObject({ action: "omitir", motivo: "sin precio" });
  });

  it("una oferta activa que baja el precio por debajo de 35 obliga a mover aunque el informe diga 45", () => {
    const ov = overrides({ sales: new Map([["2857149CLM|DE", { price: 29.99, start: "2026-11-01T00:00:00Z", end: "2026-12-01T00:00:00Z" }]]) });
    expect(decideRow(row({ price: 45 }), ov, { now: NOW })).toMatchObject({ action: "mover", price: 29.99 });
    // La misma oferta caducada ya no cuenta: el precio vuelve a 45 y no se toca.
    const expired = overrides({ sales: new Map([["2857149CLM|DE", { price: 29.99, start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z" }]]) });
    expect(decideRow(row({ price: 45 }), expired, { now: NOW })).toMatchObject({ action: "ok", price: 45 });
  });

  it("la oferta programada (aún no empezada) ya cuenta, y una con fin ilegible no", () => {
    const scheduled = overrides({ sales: new Map([["2857149CLM|DE", { price: 24.99, start: "2026-12-01T00:00:00Z", end: "2026-12-31T00:00:00Z" }]]) });
    expect(decideRow(row({ price: 45 }), scheduled, { now: NOW })).toMatchObject({ action: "mover", price: 24.99 });
    expect(activeSalePrice({ price: 24.99, start: "", end: "" }, NOW)).toBeNull();
    // Sin end no se puede saber si está vigente: se descarta (mejor no mover que mover de más).
    expect(parseSalesSnapshot({ sales: { "2857149CLM": { DE: { price: 24.99, start: "2026-11-01T00:00:00Z" } } } }).size).toBe(0);
  });

  it("precio de fixed_prices.csv y del panel mandan sobre el informe", () => {
    const fixed = overrides({ fixed: new Map([["2857149CLM|DE", 30]]) });
    expect(decideRow(row({ price: 45 }), fixed, { now: NOW })).toMatchObject({ action: "mover", price: 30 });
    const manual = overrides({ manual: new Map([["2857149CLM|DE", 39.9]]) });
    expect(decideRow(row({ price: 29.99 }), manual, { now: NOW })).toMatchObject({ action: "ok", price: 39.9 });
  });
});

describe("priceBucket y summarize", () => {
  it("reparte por tramo de precio", () => {
    expect(priceBucket(9.99)).toBe("<10");
    expect(priceBucket(10)).toBe("10-20");
    expect(priceBucket(29.99)).toBe("20-30");
    expect(priceBucket(34.99)).toBe("30-35");
    expect(priceBucket(35)).toBe("≥35");
    expect(priceBucket(null)).toBeNull();
  });

  it("cuenta acciones, motivos, tramos y familias (tramos y familias solo de lo que se mueve)", () => {
    const entries = [
      { sku: "1CLM", decision: decideRow(row({ sku: "1CLM", price: 12.5 }), emptyOverrides(), { now: NOW }), family: skuFamily("1CLM") },
      { sku: "2DCI", decision: decideRow(row({ sku: "2DCI", price: 34.99 }), emptyOverrides(), { now: NOW }), family: skuFamily("2DCI") },
      { sku: "3VCT", decision: decideRow(row({ sku: "3VCT", price: 80 }), emptyOverrides(), { now: NOW }), family: skuFamily("3VCT") },
      { sku: "4SG", decision: decideRow(row({ sku: "4SG", channel: "AMAZON_EU" }), emptyOverrides(), { now: NOW }), family: skuFamily("4SG") },
    ];
    const s = summarize(entries);
    expect(s.rows).toBe(4);
    expect(s.acciones).toEqual({ ok: 2, mover: 2, omitir: 0 });
    expect(s.motivos["precio efectivo < 35 €"]).toBe(2);
    expect(s.buckets).toMatchObject({ "<10": 0, "10-20": 1, "20-30": 0, "30-35": 1, "≥35": 0 });
    expect(s.familias).toEqual({ CLM: 1, DCI: 1 });
  });
});

describe("payload del PATCH", () => {
  it("escribe legacy-template-id en un único pointer, sin borrar el atributo", () => {
    expect(shippingGroupPatch("PRODUCT")).toEqual({
      productType: "PRODUCT",
      patches: [
        {
          op: "replace",
          path: "/attributes/merchant_shipping_group",
          value: [{ value: "legacy-template-id", marketplace_id: DE_MARKETPLACE_ID }],
        },
      ],
    });
  });

  it("usa el productType del listing y cae a PRODUCT si no hay", () => {
    expect(shippingGroupPatch("HOME_BED_AND_BATH").productType).toBe("HOME_BED_AND_BATH");
    expect(shippingGroupPatch(undefined).productType).toBe("PRODUCT");
    expect(shippingGroupPatch("  ").productType).toBe("PRODUCT");
  });
});

describe("lectura del listing en vivo", () => {
  const listing = (group: string | null, over: Record<string, unknown> = {}) => ({
    sku: "2857149CLM",
    summaries: [{ productType: "HOME_BED_AND_BATH", marketplaceId: DE_MARKETPLACE_ID }],
    attributes: {
      ...(group ? { merchant_shipping_group: [{ value: group, marketplace_id: DE_MARKETPLACE_ID }] } : {}),
      fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT" }],
      purchasable_offer: [
        { audience: "ALL", marketplace_id: DE_MARKETPLACE_ID, our_price: [{ schedule: [{ value_with_tax: 44.99 }] }] },
        { audience: "B2B", marketplace_id: DE_MARKETPLACE_ID, our_price: [{ schedule: [{ value_with_tax: 40 }] }] },
      ],
      ...over,
    },
  });

  it("lee plantilla, productType, canal y precio efectivo (ALL, no B2B)", () => {
    const free = listing(FREE_SHIPPING_GROUP);
    expect(currentShippingGroup(free)).toBe(FREE_SHIPPING_GROUP);
    expect(isFreeShippingGroup(currentShippingGroup(free))).toBe(true);
    expect(currentShippingGroup(listing(PAID_SHIPPING_GROUP))).toBe(PAID_SHIPPING_GROUP);
    expect(currentShippingGroup(listing(null))).toBeNull();
    expect(listingProductType(free)).toBe("HOME_BED_AND_BATH");
    expect(liveFulfillmentChannel(free)).toBe("DEFAULT");
    expect(liveEffectivePrice(free, NOW)).toBe(44.99);
  });

  it("un SKU con AMAZON_EU y DEFAULT a la vez cuenta como FBM", () => {
    const dual = listing(FREE_SHIPPING_GROUP, {
      fulfillment_availability: [{ fulfillment_channel_code: "AMAZON_EU" }, { fulfillment_channel_code: "DEFAULT" }],
    });
    expect(liveFulfillmentChannel(dual)).toBe("DEFAULT");
    const fba = listing(FREE_SHIPPING_GROUP, { fulfillment_availability: [{ fulfillment_channel_code: "AMAZON_EU" }] });
    expect(liveFulfillmentChannel(fba)).toBe("AMAZON_EU");
  });

  it("con oferta vigente usa el precio de oferta", () => {
    const withSale = listing(FREE_SHIPPING_GROUP, {
      purchasable_offer: [
        {
          audience: "ALL",
          marketplace_id: DE_MARKETPLACE_ID,
          our_price: [{ schedule: [{ value_with_tax: 44.99 }] }],
          discounted_price: [{ schedule: [{ value_with_tax: 29.99, end_at: "2026-12-01T00:00:00Z" }] }],
        },
      ],
    });
    expect(liveEffectivePrice(withSale, NOW)).toBe(29.99);
  });

  it("liveDecision mueve un FBM barato que sigue en la plantilla gratis", () => {
    const barato = listing(FREE_SHIPPING_GROUP, {
      purchasable_offer: [{ audience: "ALL", marketplace_id: DE_MARKETPLACE_ID, our_price: [{ schedule: [{ value_with_tax: 24.99 }] }] }],
    });
    const d = liveDecision("2857149CLM", barato, row({ price: 24.99 }), emptyOverrides(), { now: NOW });
    expect(d).toMatchObject({ action: "mover", plantillaOrigen: FREE_SHIPPING_GROUP, plantillaDestino: PAID_SHIPPING_GROUP });
  });

  it("liveDecision no toca si entre la auditoría y el PATCH ya lo movieron", () => {
    const d = liveDecision("2857149CLM", listing(PAID_SHIPPING_GROUP), row({ price: 24.99 }), emptyOverrides(), { now: NOW });
    expect(d).toMatchObject({ action: "ok", motivo: "ya en plantilla de pago (GRUPO 0)" });
  });

  it("liveDecision no toca si en vivo el atributo ya no está (plantilla por defecto = pago)", () => {
    const d = liveDecision("2857149CLM", listing(null), row({ price: 24.99 }), emptyOverrides(), { now: NOW });
    expect(d).toMatchObject({ action: "ok", motivo: "ya en plantilla de pago (GRUPO 0)", plantillaOrigen: PAID_SHIPPING_GROUP });
  });

  it("liveDecision no toca si el precio en vivo ya no es barato", () => {
    const caro = listing(FREE_SHIPPING_GROUP, {
      purchasable_offer: [{ audience: "ALL", marketplace_id: DE_MARKETPLACE_ID, our_price: [{ schedule: [{ value_with_tax: 39.9 }] }] }],
    });
    expect(liveDecision("2857149CLM", caro, row({ price: 24.99 }), emptyOverrides(), { now: NOW })).toMatchObject({
      action: "ok",
      motivo: "precio efectivo ≥ 35 €",
    });
  });

  it("liveDecision no toca si en vivo es FBA", () => {
    const fba = listing(FREE_SHIPPING_GROUP, { fulfillment_availability: [{ fulfillment_channel_code: "AMAZON_EU" }] });
    expect(liveDecision("2857149CLM", fba, row(), emptyOverrides(), { now: NOW })).toMatchObject({ action: "ok", motivo: "FBA (AMAZON_EU)" });
  });

  it("liveDecision omite si la oferta ya no tiene precio en Amazon", () => {
    const noOffer = { sku: "2857149CLM", summaries: [], attributes: { fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT" }] } };
    const d = liveDecision("2857149CLM", noOffer, row({ price: 24.99 }), emptyOverrides(), { now: NOW });
    expect(d).toMatchObject({ action: "omitir", motivo: "sin oferta en vivo" });
    expect(liveRow("2857149CLM", noOffer, row({ price: 24.99 }), NOW).price).toBeNull();
  });

  it("liveDecision no mueve con el precio exactamente en 35 €", () => {
    const justo = listing(FREE_SHIPPING_GROUP, {
      purchasable_offer: [{ audience: "ALL", marketplace_id: DE_MARKETPLACE_ID, our_price: [{ schedule: [{ value_with_tax: 35 }] }] }],
    });
    expect(liveDecision("2857149CLM", justo, row(), emptyOverrides(), { now: NOW })).toMatchObject({ action: "ok", motivo: "precio efectivo ≥ 35 €" });
  });

  it("liveDecision respeta blocked_skus.txt", () => {
    const barato = listing(FREE_SHIPPING_GROUP, {
      purchasable_offer: [{ audience: "ALL", marketplace_id: DE_MARKETPLACE_ID, our_price: [{ schedule: [{ value_with_tax: 24.99 }] }] }],
    });
    const blocked = blockedSkusFromText("2857149CLM\n");
    expect(liveDecision("2857149CLM", barato, row(), emptyOverrides(), { blocked, now: NOW })).toMatchObject({
      action: "omitir",
      motivo: "SKU retirado (blocked_skus.txt)",
      plantillaOrigen: FREE_SHIPPING_GROUP,
    });
  });

  it("liveDecision no toca una plantilla que no es ninguna de las dos", () => {
    const otra = listing("otro-uuid-cualquiera", {
      purchasable_offer: [{ audience: "ALL", marketplace_id: DE_MARKETPLACE_ID, our_price: [{ schedule: [{ value_with_tax: 19.99 }] }] }],
    });
    expect(liveDecision("2857149CLM", otra, row(), emptyOverrides(), { now: NOW })).toMatchObject({
      action: "ok",
      motivo: "otra plantilla (no es la de envío gratis)",
    });
  });

  it("la oferta B2B no decide el precio: manda la de audiencia ALL", () => {
    const soloB2b = listing(FREE_SHIPPING_GROUP, {
      purchasable_offer: [{ audience: "B2B", marketplace_id: DE_MARKETPLACE_ID, our_price: [{ schedule: [{ value_with_tax: 19.99 }] }] }],
    });
    expect(liveEffectivePrice(soloB2b, NOW)).toBeNull();
    expect(liveDecision("2857149CLM", soloB2b, row(), emptyOverrides(), { now: NOW })).toMatchObject({ action: "omitir", motivo: "sin oferta en vivo" });
  });

  it("una oferta caducada en vivo no cuenta como precio barato", () => {
    const caducada = listing(FREE_SHIPPING_GROUP, {
      purchasable_offer: [
        {
          audience: "ALL",
          marketplace_id: DE_MARKETPLACE_ID,
          our_price: [{ schedule: [{ value_with_tax: 44.99 }] }],
          discounted_price: [{ schedule: [{ value_with_tax: 19.99, end_at: "2026-01-01T00:00:00Z" }] }],
        },
      ],
    });
    expect(liveEffectivePrice(caducada, NOW)).toBe(44.99);
    expect(liveDecision("2857149CLM", caducada, row(), emptyOverrides(), { now: NOW })).toMatchObject({ action: "ok", price: 44.99 });
  });
});
