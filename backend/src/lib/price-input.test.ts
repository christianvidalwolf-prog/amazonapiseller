import { describe, expect, it } from "vitest";
import { parsePriceInput } from "./price-input.js";

describe("parsePriceInput", () => {
  it("accepts Spanish decimal notation and rounds to cents", () => {
    expect(parsePriceInput("12,345")).toBe(12.35);
  });

  it("rejects invalid and negative prices", () => {
    expect(() => parsePriceInput("abc")).toThrow("precio válido");
    expect(() => parsePriceInput(-1)).toThrow("precio válido");
  });
});
