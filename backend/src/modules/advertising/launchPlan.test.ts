import { describe, expect, it } from "vitest";
import seedJson from "../../../ads/keywords/40973_keywords.json";
import { buildLaunchPlan, fbaReady, type LaunchSeed, parseLaunchSeed, tacosBudgetCap, targetCpc, validateLaunchSeed } from "./launchPlan";

const seed = parseLaunchSeed(seedJson);
const withBid = (bid: number): LaunchSeed => ({
  ...seed,
  campaigns: { ...seed.campaigns, Exact: { ...seed.campaigns.Exact, keywords: [{ text: "bingo 90 bolas", bid }] } },
});

describe("launch seed 40973", () => {
  it("passes every rule", () => {
    expect(validateLaunchSeed(seed)).toEqual([]);
  });

  it("rejects a bid above the real cap and caps above the absolute 1 €", () => {
    expect(validateLaunchSeed(withBid(0.73))).toEqual(['Exact "bingo 90 bolas": puja 0.73 € supera el techo 0.72 €']);
    const loose = { ...seed, bidCaps: { real: 1.2, absolute: 1.5 } };
    expect(validateLaunchSeed(loose)).toEqual(expect.arrayContaining(["techo absoluto 1.5 € supera 1 €"]));
  });

  it("rejects a target ACoS that is not below break-even", () => {
    const bad = { ...seed, economics: { ...seed.economics, targetAcos: 25 } };
    expect(validateLaunchSeed(bad)[0]).toMatch(/ACoS objetivo 25 %/);
  });

  it("rejects a keyword that is also a negative", () => {
    const bad = { ...seed, negatives: { ...seed.negatives, all: [...seed.negatives.all, "Bingo 90 Bolas"] } };
    expect(validateLaunchSeed(bad)).toEqual(['Exact: "bingo 90 bolas" es a la vez keyword y negativa']);
  });

  it("rejects a seed with missing fields", () => {
    expect(() => parseLaunchSeed({ family: "1" })).toThrow(/Seed inválido/);
  });
});

describe("buildLaunchPlan", () => {
  const plan = buildLaunchPlan(seed);

  it("creates the four SP-40973 campaigns with one ad group holding both SKUs", () => {
    expect(plan.campaigns.map((c) => [c.name, c.targetingType])).toEqual([
      ["PF | ES | SP-40973 | Auto", "AUTO"],
      ["PF | ES | SP-40973 | Exact", "MANUAL"],
      ["PF | ES | SP-40973 | Phrase", "MANUAL"],
      ["PF | ES | SP-40973 | Marca", "MANUAL"],
    ]);
    for (const c of plan.campaigns) expect(c.adGroups.map((g) => g.skus)).toEqual([["40973MDFBA", "40973MD"]]);
    expect(plan.pauseOld).toEqual([]);
  });

  it("uses the campaign's match type and isolates exact terms in Auto and Phrase", () => {
    const [auto, exact, phrase, marca] = plan.campaigns;
    expect(new Set(exact.adGroups[0].keywords.map((k) => k.matchType))).toEqual(new Set(["EXACT"]));
    expect(new Set(phrase.adGroups[0].keywords.map((k) => k.matchType))).toEqual(new Set(["PHRASE"]));
    expect(marca.adGroups[0].keywords.map((k) => k.matchType)).toEqual(["EXACT", "PHRASE"]);
    expect(auto.adGroups[0].autoBids).toEqual(seed.campaigns.Auto.autoBids);
    expect(auto.negativeKeywords).toEqual(expect.arrayContaining(["bingo 90 bolas", "bingo electronico"]));
    expect(phrase.negativeKeywords).toContain("bingo 90 bolas");
    expect(exact.negativeKeywords).not.toContain("bingo 90 bolas");
  });

  it("adds up the daily budget", () => {
    expect(plan.dailyBudget).toBe(8);
  });
});

describe("launch gates", () => {
  it("FBA activates only with fulfillable + inbound ≥ the minimum", () => {
    expect(fbaReady({ fulfillable: 12, inbound: 8 }, 20)).toEqual({ ready: true, total: 20 });
    expect(fbaReady({ fulfillable: 12, inbound: 7 }, 20)).toEqual({ ready: false, total: 19 });
    expect(fbaReady(null, 20)).toEqual({ ready: false, total: 0 });
  });

  it("TACoS cap follows daily sales, none without sales", () => {
    expect(tacosBudgetCap(100, 12)).toBe(12);
    expect(tacosBudgetCap(0, 12)).toBeNull();
  });

  it("target CPC from gross price, CVR and target ACoS", () => {
    expect(targetCpc(seed, 0.1)).toBe(0.57);
  });
});
