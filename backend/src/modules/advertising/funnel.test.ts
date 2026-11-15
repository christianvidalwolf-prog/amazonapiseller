import { describe, expect, it } from "vitest";
import { levelOf, planFunnel } from "./funnel";

const names = new Map([
  ["A", "PF | ES | AUTO | Varios"],
  ["F", "PF | ES | MANUAL | FRASE"],
  ["E", "PF | ES | MANUAL | EXACTA"],
]);
const row = (campaignId: string, searchTerm: string, clicks: number, orders: number, cost: number, sales: number) =>
  ({ campaignId, adGroupId: `${campaignId}g`, searchTerm, clicks, purchases7d: orders, cost, sales7d: sales }) as never;
const empty = () => ({ exact: new Set<string>(), phrase: new Set<string>(), asin: new Set<string>() });

describe("funnel", () => {
  it("classifies campaign levels", () => {
    expect(levelOf("PF | IT | FBA Sellers")).toBe("auto");
    expect(levelOf("PF | ES | MANUAL | FRASE")).toBe("phrase");
    expect(levelOf("PF | ES | SP-3041311 | Exact")).toBe("exact");
    expect(levelOf("PF | ES | MANUAL | ASIN")).toBe("asin");
  });

  it("promotes proven terms to exact with negatives in every origin, signals to phrase, ASINs to ASIN", () => {
    const plan = planFunnel(
      [
        row("A", "Salero Cerámica", 6, 1, 1.2, 15),
        row("F", "salero cerámica", 4, 1, 0.8, 15), // 10 clics, 2 pedidos, ACoS 6,7 % → exacta
        row("A", "figura buda", 5, 1, 1, 10), // 1 pedido, ACoS 10 % → frase
        row("A", "b0abc12345", 9, 2, 2, 30), // ASIN → campaña ASIN
        row("A", "regalo", 20, 0, 4, 0), // sin ventas → nada
        row("E", "salero exacto", 30, 5, 3, 100), // ya es exacta → no es origen
      ],
      names,
      empty()
    );
    expect(plan.map((p) => [p.to, p.term])).toEqual([
      ["exact", "salero cerámica"],
      ["asin", "b0abc12345"],
      ["phrase", "figura buda"],
    ]);
    expect(plan[0].origins.map((o) => o.campaignId).sort()).toEqual(["A", "F"]);
    expect(plan[0].bid).toBe(0.22); // CPC 0,20 + 10 %
  });

  it("skips terms already live at the destination and blocked ones", () => {
    const live = empty();
    live.exact.add("salero cerámica");
    expect(planFunnel([row("A", "salero cerámica", 10, 2, 2, 30)], names, live)).toEqual([]);
    expect(planFunnel([row("A", "figura buda", 5, 1, 1, 10)], names, empty(), new Set(["figura buda"]))).toEqual([]);
  });
});
