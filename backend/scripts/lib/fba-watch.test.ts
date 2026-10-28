import { describe, expect, it } from "vitest";
import { alertHtml, alertSubject, inactiveReasons, isGradeAndResell, isIgnored, parseIgnoreRules, type InactiveListing } from "./fba-watch";

describe("inactiveReasons", () => {
  it("returns null for a buyable listing", () => {
    expect(inactiveReasons(["DISCOVERABLE", "BUYABLE"], [{ code: "1", message: "x", severity: "ERROR" }])).toBeNull();
  });

  it("lists the ERROR issues, without duplicates", () => {
    const issues = [
      { code: "18155", message: "Precio bajo el mínimo", severity: "ERROR" },
      { code: "18155", message: "Precio bajo el mínimo", severity: "ERROR" },
      { code: "99", message: "Aviso", severity: "WARNING" },
    ];
    expect(inactiveReasons(["DISCOVERABLE"], issues)).toEqual(["18155: Precio bajo el mínimo"]);
  });

  it("falls back to the status when Amazon gives no error", () => {
    expect(inactiveReasons(["DISCOVERABLE"], [])).toEqual(["Estado DISCOVERABLE sin errores informados"]);
    expect(inactiveReasons([], [])).toEqual(["Sin estado en Amazon (oferta no creada o sin precio)"]);
  });
});

describe("alert email", () => {
  const rows: InactiveListing[] = [
    { sku: "A<1>", pais: "ES", asin: "B000", unidades: 3, estado: ["DISCOVERABLE"], motivos: ["18155: x"] },
    { sku: "B", pais: "IT", asin: null, unidades: 10, estado: [], motivos: ["sin estado"] },
  ];

  it("builds the subject with count and countries", () => {
    expect(alertSubject(rows)).toBe("FBA: 2 listings inactivos con stock (ES, IT)");
    expect(alertSubject(rows.slice(0, 1))).toBe("FBA: 1 listing inactivo con stock (ES)");
  });

  it("escapes HTML and sorts by units", () => {
    const html = alertHtml(rows, "2026-10-22");
    expect(html).toContain("A&lt;1&gt;");
    expect(html).toContain("https://www.amazon.es/dp/B000");
    expect(html.indexOf(">B<")).toBeLessThan(html.indexOf("A&lt;1&gt;"));
  });
});

it("isGradeAndResell spots Amazon's used-resale SKUs", () => {
  expect(isGradeAndResell("amzn.gr.10168SG-0BdBdhqwBHo3qn-Gb6uqY-LN")).toBe(true);
  expect(isGradeAndResell("10168SGFBA")).toBe(false);
});

describe("ignore rules", () => {
  const rules = parseIgnoreRules("# comentario\n14807VCFBA;*;El SKU no existe\n\n7752VCFBA;DE;19098  # GTIN\n1297VCFBA\n");

  it("parses SKU, country and reason, skipping comments and blank lines", () => {
    expect(rules).toEqual([
      { sku: "14807VCFBA", pais: "*", motivo: "El SKU no existe" },
      { sku: "7752VCFBA", pais: "DE", motivo: "19098" },
      { sku: "1297VCFBA", pais: "*", motivo: "" },
    ]);
  });

  it("hides a listing only for its country and while every reason matches", () => {
    expect(isIgnored({ sku: "7752VCFBA", pais: "DE", motivos: ["19098: GTIN"] }, rules)).toBe(true);
    expect(isIgnored({ sku: "7752VCFBA", pais: "FR", motivos: ["19098: GTIN"] }, rules)).toBe(false);
    expect(isIgnored({ sku: "7752VCFBA", pais: "DE", motivos: ["19098: GTIN", "18155: Precio"] }, rules)).toBe(false);
    expect(isIgnored({ sku: "14807VCFBA", pais: "IT", motivos: ["El SKU no existe en este marketplace"] }, rules)).toBe(true);
    expect(isIgnored({ sku: "1297VCFBA", pais: "IT", motivos: ["cualquier cosa"] }, rules)).toBe(true);
    expect(isIgnored({ sku: "OTRO", pais: "IT", motivos: ["19098: GTIN"] }, rules)).toBe(false);
  });
});
