import { describe, expect, it } from "vitest";
import seedJson from "../../../ads/keywords/40973_keywords.json";
import reyesJson from "../../../ads/keywords/3041311_keywords.json";
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

describe("seasonal seed 3041311 (ASIN campaign and end date)", () => {
  const reyes = parseLaunchSeed(reyesJson);
  const plan = buildLaunchPlan(reyes);

  it("passes every rule", () => {
    expect(validateLaunchSeed(reyes)).toEqual([]);
  });

  it("adds the ASIN campaign with ASIN and category targets and no keyword negatives", () => {
    const asin = plan.campaigns.find((c) => c.name === "PF | ES | SP-3041311 | ASIN");
    expect(asin?.targetingType).toBe("MANUAL");
    expect(asin?.negativeKeywords).toEqual([]);
    const targets = asin?.adGroups[0].targets ?? [];
    expect(targets).toContainEqual({ asin: "B0CM3STMNX", bid: 0.4 });
    expect(targets).toContainEqual({ asin: "1642034031", bid: 0.2, type: "ASIN_CATEGORY_SAME_AS" });
    expect(asin?.adGroups[0].skus).toEqual(["3041311DCIFBA", "3041311DCI"]);
  });

  it("puts the end date on every campaign and adds up five budgets", () => {
    expect(plan.campaigns).toHaveLength(5);
    expect(new Set(plan.campaigns.map((c) => c.endDate))).toEqual(new Set(["2026-12-28"]));
    expect(plan.dailyBudget).toBe(8);
  });

  it("rejects targeting its own ASIN, a bad end date and a target with both asin and category", () => {
    const own = { ...reyes, campaigns: { ...reyes.campaigns, Asin: { dailyBudget: 1, defaultBid: 0.2, targets: [{ asin: "B0HKPFHF6F", bid: 0.2 }] } } };
    expect(validateLaunchSeed(own)).toEqual(["ASIN: no puede segmentar su propio ASIN B0HKPFHF6F"]);
    expect(() => parseLaunchSeed({ ...reyesJson, endDate: "28/12/2026" })).toThrow(/endDate/);
    const both = { ...reyesJson, campaigns: { ...reyesJson.campaigns, Asin: { dailyBudget: 1, defaultBid: 0.2, targets: [{ asin: "B0X", category: "1", bid: 0.2 }] } } };
    expect(() => parseLaunchSeed(both)).toThrow(/campaigns.Asin/);
  });

  it("seeds without an ASIN campaign or end date keep four campaigns and no end date", () => {
    expect(buildLaunchPlan(seed).campaigns.every((c) => c.endDate === undefined)).toBe(true);
  });
});
