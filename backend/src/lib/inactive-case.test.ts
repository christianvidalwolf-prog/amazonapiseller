import { describe, expect, it } from "vitest";
import { caseKey, classifyCase, type InactiveCase, planFixes, summarizePlan } from "./inactive-case";

const base: InactiveCase = {
  sku: "1234VCFBA",
  country: "DE",
  asin: "B00TEST001",
  units: 3,
  status: ["DISCOVERABLE"],
  issues: [],
  exists: true,
  productType: "PRODUCT",
  offer: { hasNormal: true, hasPrice: true, hasBusiness: true, hasExpiredSale: false },
};

const make = (patch: Partial<InactiveCase> = {}): InactiveCase => ({ ...base, ...patch });
const error = (code: string, message = "") => ({ code, message, severity: "ERROR" });

describe("classifyCase", () => {
  it("ignora los SKU de devoluciones Grade and Resell", () => {
    const c = classifyCase(make({ sku: "amzn.gr.abc-123", exists: false }));
    expect(c.action).toBe("ignore");
  });

  it("espera si Amazon está revisando el anuncio (100521)", () => {
    expect(classifyCase(make({ issues: [error("100521")] })).action).toBe("wait");
  });

  it("crea la oferta cuando el SKU no existe y hay ASIN", () => {
    const c = classifyCase(make({ exists: false, status: [] }));
    expect(c).toMatchObject({ action: "create-offer", auto: true });
  });

  it("escala si no existe y no hay ASIN con el que recrearlo", () => {
    expect(classifyCase(make({ exists: false, asin: null })).action).toBe("escalate");
  });

  it("aplica GPSR por 100632 de seguridad del producto", () => {
    const c = classifyCase(make({ issues: [error("100632", "Falta la regulación general de seguridad del producto (GPSR)")] }));
    expect(c).toMatchObject({ action: "gpsr", auto: true });
  });

  it("escala el 100632 de RAP/EPR", () => {
    const c = classifyCase(make({ issues: [error("100632", "Falta la información de una RER (registro del productor)")] }));
    expect(c.action).toBe("escalate");
  });

  it("escala los códigos de cumplimiento sin arreglo por API", () => {
    for (const code of ["100390", "19084", "19098", "18146", "18570", "18967", "18644", "100720", "13013", "90220"]) {
      expect(classifyCase(make({ issues: [error(code, "x")] })).action, code).toBe("escalate");
    }
  });

  it("corrige límites con 18155, 18639 y 99022", () => {
    expect(classifyCase(make({ issues: [error("18155", "precio por debajo del umbral")] })).action).toBe("bounds");
    expect(classifyCase(make({ issues: [error("18639", "posible error de precio")] })).action).toBe("bounds");
    expect(classifyCase(make({ issues: [error("99022", "value_with_tax")] })).action).toBe("bounds");
  });

  it("rellena el precio normal cuando la oferta solo es B2B o no tiene importe", () => {
    expect(classifyCase(make({ offer: { hasNormal: false, hasPrice: false, hasBusiness: true, hasExpiredSale: false } })).action).toBe("fill-price");
    expect(classifyCase(make({ offer: { hasNormal: true, hasPrice: false, hasBusiness: false, hasExpiredSale: false } })).action).toBe("fill-price");
  });

  it("limpia una promoción o un fin de oferta vencidos", () => {
    const c = classifyCase(make({ offer: { hasNormal: true, hasPrice: true, hasBusiness: false, hasExpiredSale: true } }));
    expect(c.action).toBe("bounds");
  });

  it("escala unit_count fuera del enum del país", () => {
    expect(classifyCase(make({ issues: [error("90244", "unit_count.type")] })).action).toBe("escalate");
  });

  it("intenta límites cuando no hay BUYABLE ni errores", () => {
    expect(classifyCase(make()).action).toBe("bounds");
  });
});

describe("planFixes", () => {
  it("un arreglo por SKU+país, más unidades primero y con tope", () => {
    const cases = [
      make({ sku: "A", units: 1 }),
      make({ sku: "B", units: 9 }),
      make({ sku: "B", units: 9 }),
      make({ sku: "C", units: 5, country: "FR" }),
    ];
    const plan = planFixes(cases, { maxFixes: 2 });
    expect(plan.work.map((p) => `${p.item.sku}|${p.item.country}`)).toEqual(["B|DE", "C|FR"]);
    expect(caseKey(plan.work[0].item)).toBe("B|DE");
  });

  it("escala los casos sin arreglo por API y los que ya fallaron demasiadas veces", () => {
    const cases = [
      make({ sku: "DOC", issues: [error("100390", "docs")] }),
      make({ sku: "FIX", issues: [error("18155", "precio")] }),
      make({ sku: "WAIT", issues: [error("100521", "")] }),
    ];
    const plan = planFixes(cases, { maxFixes: 10, attempts: { "FIX|DE": 2 }, maxAttempts: 2 });
    expect(plan.work).toHaveLength(0);
    expect(plan.manual.map((p) => p.item.sku).sort()).toEqual(["DOC", "FIX", "WAIT"]);
  });

  it("deja reintentar mientras no se alcance el máximo de intentos", () => {
    const plan = planFixes([make()], { maxFixes: 10, attempts: { "1234VCFBA|DE": 1 }, maxAttempts: 2 });
    expect(plan.work).toHaveLength(1);
    expect(plan.work[0].attempts).toBe(1);
  });

  it("resume el plan por acción", () => {
    const plan = planFixes([make(), make({ sku: "DOC", issues: [error("100390", "")] })], { maxFixes: 10 });
    expect(summarizePlan(plan)).toMatchObject({ bounds: 1, escalate: 1 });
  });
});
