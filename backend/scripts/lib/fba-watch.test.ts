import { describe, expect, it } from "vitest";
import { inactiveReasons } from "./fba-watch";

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
