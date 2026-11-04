import { describe, expect, it } from "vitest";
import {
  buyerShipping,
  isOwnOffer,
  parseAppliedSkusCsv,
  parsePricingOffers,
  pickSample,
  readMoney,
  summarizeBuyerShipping,
} from "./de-buyer-shipping";

const SELLER = "A3RY0L9OY3TPHI";

/** Oferta de la Pricing API como la devuelve Amazon (solo los campos que se leen). */
const offer = (over: Record<string, unknown> = {}) => ({
  SellerId: SELLER,
  MyOffer: true,
  IsFulfilledByAmazon: false,
  ListingPrice: { CurrencyCode: "EUR", Amount: 24.95 },
  Shipping: { CurrencyCode: "EUR", Amount: 3.99 },
  ...over,
});

describe("readMoney", () => {
  it("lee el importe de {Amount} y redondea a céntimos", () => {
    expect(readMoney({ Amount: 3.99 })).toBe(3.99);
    expect(readMoney({ Amount: "0" })).toBe(0);
    expect(readMoney({ Amount: "3,99" })).toBe(3.99);
    expect(readMoney({ Amount: 1.005 })).toBe(1.01);
  });

  it("devuelve null si no hay importe", () => {
    expect(readMoney(undefined)).toBeNull();
    expect(readMoney({})).toBeNull();
    expect(readMoney({ Amount: "n/a" })).toBeNull();
  });
});

describe("parsePricingOffers / isOwnOffer", () => {
  it("normaliza las ofertas y detecta la propia por MyOffer o por SellerId", () => {
    const [mine, bySellerId, other] = parsePricingOffers({
      Offers: [
        offer(),
        offer({ MyOffer: false, SellerId: SELLER, Shipping: { Amount: 0 } }),
        offer({ MyOffer: false, SellerId: "OTHER" }),
      ],
    });
    expect(mine).toMatchObject({ myOffer: true, fulfilledByAmazon: false, shipping: 3.99, listingPrice: 24.95 });
    expect(isOwnOffer(mine, SELLER)).toBe(true);
    expect(isOwnOffer(bySellerId, SELLER)).toBe(true);
    expect(isOwnOffer(other, SELLER)).toBe(false);
  });

  it("sin Offers devuelve lista vacía (y no revienta)", () => {
    expect(parsePricingOffers({})).toEqual([]);
    expect(parsePricingOffers(null)).toEqual([]);
  });
});

describe("buyerShipping: lo que paga el comprador", () => {
  it("FBM propia con Shipping 3,99 → cobrando (el arreglo llegó al comprador)", () => {
    const v = buyerShipping({ Offers: [offer()] }, SELLER);
    expect(v).toMatchObject({ verdict: "cobrando", price: 24.95, shipping: 3.99, ownOffers: 1, ownFbmOffers: 1 });
  });

  it("FBM propia con Shipping 0 → aun-cero (Amazon todavía no ha recalculado)", () => {
    const v = buyerShipping({ Offers: [offer({ Shipping: { Amount: 0 } })] }, SELLER);
    expect(v).toMatchObject({ verdict: "aun-cero", shipping: 0, price: 24.95 });
  });

  it("SKU híbrido: la oferta FBA propia (0,00) no tapa la FBM (3,99)", () => {
    // Caso real 45927RGSG: FBA 46,95 con envío 0,00 y FBM 54,95 con envío 3,99.
    const payload = {
      Offers: [
        offer({ MyOffer: false, IsFulfilledByAmazon: true, ListingPrice: { Amount: 46.95 }, Shipping: { Amount: 0 } }),
        offer({ MyOffer: true, IsFulfilledByAmazon: false, ListingPrice: { Amount: 54.95 }, Shipping: { Amount: 3.99 } }),
      ],
    };
    const v = buyerShipping(payload, SELLER);
    expect(v).toMatchObject({ verdict: "cobrando", price: 54.95, shipping: 3.99, ownOffers: 2, ownFbmOffers: 1 });
  });

  it("dos ofertas FBM propias: manda la que cobra", () => {
    const v = buyerShipping({
      Offers: [offer({ Shipping: { Amount: 0 } }), offer({ MyOffer: false, Shipping: { Amount: 3.36 } })],
    }, SELLER);
    expect(v).toMatchObject({ verdict: "cobrando", shipping: 3.36, ownFbmOffers: 2 });
    expect(v.detail).toContain("+1 oferta(s) FBM más");
  });

  it("si solo hay oferta FBA propia, la plantilla no aplica (solo-fba)", () => {
    const v = buyerShipping({ Offers: [offer({ IsFulfilledByAmazon: true, Shipping: { Amount: 0 } })] }, SELLER);
    expect(v).toMatchObject({ verdict: "solo-fba", ownFbmOffers: 0 });
  });

  it("sin oferta propia (o sin ofertas) no se puede juzgar", () => {
    expect(buyerShipping({ Offers: [offer({ MyOffer: false, SellerId: "OTHER" })] }, SELLER).verdict).toBe("sin-oferta");
    const empty = buyerShipping({ Offers: [] }, SELLER);
    expect(empty.verdict).toBe("sin-oferta");
    expect(empty.detail).toContain("no existe");
  });

  it("NoBuyableOffers se distingue de 'no existe' en el detalle (no es un fallo de plantilla)", () => {
    const v = buyerShipping({ status: "NoBuyableOffers", Offers: [] }, SELLER);
    expect(v.verdict).toBe("sin-oferta");
    expect(v.detail).toBe("sin oferta comprable (Amazon: NoBuyableOffers)");
  });

  it("si Amazon no manda Shipping, el veredicto es sin-dato (no se inventa 0,00)", () => {
    const v = buyerShipping({ Offers: [offer({ Shipping: undefined })] }, SELLER);
    expect(v).toMatchObject({ verdict: "sin-dato", shipping: null, price: 24.95 });
  });
});

describe("parseAppliedSkusCsv", () => {
  const csv = [
    "at,sku,plantilla_origen,plantilla_destino",
    "2026-11-04T21:43:13.641Z,10010VC,395e11ea-3c51-4820-aa8f-74e6cf2a4e72,legacy-template-id",
    "2026-11-04T21:43:13.641Z,10007VC,395e11ea-3c51-4820-aa8f-74e6cf2a4e72,legacy-template-id",
    "2026-11-04T21:43:14.000Z,10010VC,395e11ea-3c51-4820-aa8f-74e6cf2a4e72,legacy-template-id",
  ].join("\n");

  it("saca los SKU en orden, sin duplicados", () => {
    expect(parseAppliedSkusCsv(csv)).toEqual(["10010VC", "10007VC"]);
  });

  it("aguanta BOM, CRLF y líneas vacías", () => {
    expect(parseAppliedSkusCsv(`\uFEFF${csv.replace(/\n/g, "\r\n")}\r\n\r\n`)).toEqual(["10010VC", "10007VC"]);
  });

  it("sin cabecera reconocible usa la primera columna", () => {
    expect(parseAppliedSkusCsv("10010VC,foo\n10007VC,bar\n")).toEqual(["10010VC", "10007VC"]);
  });

  it("un CSV vacío no revienta", () => {
    expect(parseAppliedSkusCsv("")).toEqual([]);
  });
});

describe("pickSample", () => {
  it("n ≥ tamaño → todos; n = 0 → ninguno; sin mutar la entrada", () => {
    const items = ["a", "b", "c"];
    expect(pickSample(items, 5)).toEqual(items);
    expect(pickSample(items, 0)).toEqual([]);
    expect(items).toEqual(["a", "b", "c"]);
  });

  it("devuelve exactamente n elementos distintos de la entrada", () => {
    const items = Array.from({ length: 50 }, (_, i) => `S${i}`);
    const sample = pickSample(items, 5);
    expect(sample).toHaveLength(5);
    expect(new Set(sample).size).toBe(5);
    for (const sku of sample) expect(items).toContain(sku);
  });
});

describe("summarizeBuyerShipping", () => {
  it("cuenta y sale en verde si todos cobran", () => {
    const s = summarizeBuyerShipping([{ verdict: "cobrando" }, { verdict: "cobrando" }]);
    expect(s).toMatchObject({ total: 2, charging: 2, stillZero: 0, exitCode: 0 });
  });

  it("código 1 en cuanto uno sigue a 0,00", () => {
    const s = summarizeBuyerShipping([{ verdict: "cobrando" }, { verdict: "aun-cero" }, { verdict: "sin-oferta" }]);
    expect(s).toMatchObject({ total: 3, charging: 1, stillZero: 1, unreadable: 1, exitCode: 1 });
  });

  it("sin nada juzgable no es verde (no concluyente)", () => {
    expect(summarizeBuyerShipping([{ verdict: "sin-oferta" }, { verdict: "solo-fba" }]).exitCode).toBe(1);
    expect(summarizeBuyerShipping([{ verdict: "solo-fba" }]).other).toBe(1);
  });

  it("lista vacía → verde sin nada que comprobar", () => {
    expect(summarizeBuyerShipping([]).exitCode).toBe(0);
  });
});
