import { describe, expect, it } from "vitest";
import { buildCampaignPlan, type PlanCandidate, sustainableCpc } from "./campaignPlan";

const cand = (sku: string, over: Partial<PlanCandidate> = {}): PlanCandidate => ({
  sku,
  asin: `B0${sku}`,
  family: "Hogar y cocina",
  brand: null,
  price: 40,
  unitProfit: 12,
  breakEvenAcos: 30,
  alpha: 1,
  flags: [],
  clicks: 0,
  sameSkuSales: 0,
  ...over,
});

const base = {
  country: "ES",
  prefix: "PF",
  dailyBudget: 20,
  accountCvr: 0.03,
  terms: [],
  autoMultipliers: { loose: 0.66, complements: 0 },
  brandNames: ["Rocking Gifts"],
  oldEnabledCampaigns: [{ campaignId: "old1", name: "FBA sellers" }],
};

describe("sustainableCpc", () => {
  it("is price × country CVR × 65 % of break-even × alpha without history", () => {
    expect(sustainableCpc(cand("A"), 0.03)).toBe(0.23); // 40 × 0.03 × 0.30 × 0.65
    expect(sustainableCpc(cand("A", { alpha: 0.5 }), 0.03)).toBe(0.12);
  });
  it("blends the SKU's own revenue per click with 50 prior clicks", () => {
    expect(sustainableCpc(cand("A", { clicks: 50, sameSkuSales: 100 }), 0.03)).toBe(0.31); // (100 + 50 × 40 × 0.03) / 100 × 0.195
  });
});

describe("buildCampaignPlan", () => {
  it("excludes what cannot be advertised profitably, with the reason", () => {
    const plan = buildCampaignPlan({
      ...base,
      candidates: [
        cand("OK1"),
        cand("NOBB", { alpha: 0, flags: ["SIN_BUY_BOX"] }),
        cand("CHEAP", { unitProfit: 2 }),
        cand("NOPRICE", { price: null }),
        cand("TINY", { price: 8, breakEvenAcos: 10 }),
      ],
    });
    expect(Object.fromEntries(plan.excluded.map((e) => [e.sku, e.reason]))).toMatchObject({
      NOBB: "Sin Buy Box en este país",
      CHEAP: expect.stringContaining("< 3 €"),
      NOPRICE: "Sin oferta/precio en este país",
      TINY: expect.stringContaining("no compite"),
    });
  });

  it("groups AUTO by family and bid tier, with per-targeting bids, and isolates harvested terms", () => {
    const plan = buildCampaignPlan({
      ...base,
      candidates: [cand("A1"), cand("A2"), cand("A3"), cand("H1", { price: 90 }), cand("J1", { family: "Juguetes" })],
      terms: [
        { text: "salvamanteles mimbre", isAsin: false, orders: 3, acos: 7, suggestedBid: 0.21, skus: ["A1"] },
        { text: "B004XDGF9K", isAsin: true, orders: 2, acos: 5, suggestedBid: 0.36, skus: ["H1", "GONE"] },
      ],
    });
    const names = plan.campaigns.map((c) => c.name);
    expect(names).toEqual(["PF · ES · AUTO · Hogar y cocina", "PF · ES · AUTO · Varios", "PF · ES · MANUAL · EXACTA", "PF · ES · MANUAL · ASIN"]);
    const hogar = plan.campaigns[0];
    expect(hogar.adGroups.map((g) => [g.name, g.skus])).toEqual([
      ["Puja A", ["H1"]],
      ["Puja B", ["A1", "A2", "A3"]],
    ]);
    expect(hogar.adGroups[1]).toMatchObject({ defaultBid: 0.23, autoBids: { close: 0.23, substitutes: 0.23, loose: 0.15, complements: 0 } });
    expect(hogar).toMatchObject({ negativeKeywords: ["salvamanteles mimbre"], negativeAsins: ["B004XDGF9K"] });
    expect(plan.campaigns[3].adGroups[0]).toMatchObject({ skus: ["H1"], targets: [{ asin: "B004XDGF9K", bid: 0.36 }] });
    expect(plan.pauseOld).toEqual([{ campaignId: "old1", name: "FBA sellers" }]);
  });

  it("splits the daily budget: 15 % exact, 20 % ASIN, 5 % brand, the rest by AUTO capacity, min 1 €", () => {
    const plan = buildCampaignPlan({
      ...base,
      candidates: [cand("A1", { brand: "Rocking Gifts" }), cand("A2"), cand("A3")],
      terms: [{ text: "mimbre", isAsin: false, orders: 1, acos: 7, suggestedBid: 0.2, skus: ["A1"] }],
    });
    const budget = Object.fromEntries(plan.campaigns.map((c) => [c.name.split(" · ").slice(2).join(" · "), c.dailyBudget]));
    expect(budget).toEqual({ "AUTO · Hogar y cocina": 16, "MANUAL · EXACTA": 3, MARCA: 1 });
    expect(plan.campaigns.find((c) => c.name.endsWith("MARCA"))?.adGroups[0].keywords).toEqual([{ text: "rocking gifts", matchType: "PHRASE", bid: 0.12 }]);
  });

  it("with a small budget, families share one AUTO campaign and the total stays on budget", () => {
    const families = ["Hogar y cocina", "Juguetes", "Moda"];
    const plan = buildCampaignPlan({
      ...base,
      dailyBudget: 5,
      candidates: families.flatMap((family, f) => [0, 1, 2].map((i) => cand(`${f}${i}`, { family }))),
    });
    const autos = plan.campaigns.filter((c) => c.targetingType === "AUTO");
    expect(autos.map((c) => c.name)).toEqual(["PF · ES · AUTO · Catálogo"]);
    expect(autos[0].adGroups.map((g) => g.name)).toEqual(["Hogar y cocina · Puja B", "Juguetes · Puja B", "Moda · Puja B"]);
    expect(plan.campaigns.reduce((a, c) => a + c.dailyBudget, 0)).toBeLessThanOrEqual(5);
  });

  it("pools small families into 'Otros' and sends brand searches to the brand campaign only", () => {
    const plan = buildCampaignPlan({
      ...base,
      dailyBudget: 5,
      candidates: [cand("A1"), cand("A2"), cand("A3"), cand("X1", { family: "Brújulas" }), cand("Y1", { family: "Posavasos", brand: "Rocking Gifts" })],
      terms: [{ text: "rocking gifts figura", isAsin: false, orders: 1, acos: 5, suggestedBid: 0.27, skus: ["A1"] }],
    });
    const auto = plan.campaigns.find((c) => c.targetingType === "AUTO");
    expect(auto?.adGroups.map((g) => g.name)).toEqual(["Hogar y cocina · Puja B", "Otros · Puja B"]);
    expect(auto?.negativeKeywords).toEqual(["rocking gifts figura"]);
    expect(plan.campaigns.some((c) => c.name.endsWith("EXACTA"))).toBe(false);
    const brand = plan.campaigns.find((c) => c.name.endsWith("MARCA"));
    expect(brand?.adGroups[0].keywords.map((k) => [k.text, k.matchType])).toEqual([
      ["rocking gifts", "PHRASE"],
      ["rocking gifts figura", "EXACT"],
    ]);
  });
});

