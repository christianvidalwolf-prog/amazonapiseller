import { describe, expect, it } from "vitest";
import { adGroupTargetAcos, planIsolation, pruneSubstitutes } from "./structure";
import { regulate } from "./regulator";

const campaigns = [
  { campaignId: "auto", name: "PF | ES | AUTO | Varios", state: "ENABLED", targetingType: "AUTO" },
  { campaignId: "exact", name: "PF | ES | MANUAL | EXACTA", state: "ENABLED", targetingType: "MANUAL" },
  { campaignId: "phrase", name: "PF | ES | MANUAL | FRASE", state: "ENABLED", targetingType: "MANUAL" },
  { campaignId: "other", name: "PF | ES | AUTO | Moda", state: "ENABLED", targetingType: "AUTO" },
];
const productAds = [
  { campaignId: "auto", adGroupId: "ag-auto", sku: "A", state: "ENABLED" },
  { campaignId: "exact", adGroupId: "ag-exact", sku: "A", state: "ENABLED" },
  { campaignId: "phrase", adGroupId: "ag-phrase", sku: "A", state: "ENABLED" },
  { campaignId: "other", adGroupId: "ag-other", sku: "B", state: "ENABLED" },
];
const keywords = [
  { keywordId: "k1", campaignId: "exact", adGroupId: "ag-exact", keywordText: "Carta  Reyes Magos", matchType: "EXACT", state: "ENABLED" },
  { keywordId: "k2", campaignId: "phrase", adGroupId: "ag-phrase", keywordText: "carta reyes", matchType: "PHRASE", state: "ENABLED" },
];

describe("planIsolation", () => {
  it("negates an active exact keyword in the origin ad groups that advertise the same SKU", () => {
    const plan = planIsolation({ campaigns, keywords, productAds, negatives: [], records: [] });
    expect(plan.create.map((c) => c.adGroupId).sort()).toEqual(["ag-auto", "ag-phrase"]);
    expect(plan.create.every((c) => c.term === "carta reyes magos")).toBe(true);
    expect(plan.remove).toEqual([]);
  });

  it("skips phrase ad groups whose phrases cannot match the search", () => {
    const other = keywords.map((k) => (k.keywordId === "k2" ? { ...k, keywordText: "posavasos" } : k));
    const plan = planIsolation({ campaigns, keywords: other, productAds, negatives: [], records: [] });
    expect(plan.create.map((c) => c.adGroupId)).toEqual(["ag-auto"]);
  });

  it("skips negatives that already exist", () => {
    const negatives = [{ campaignId: "auto", adGroupId: "ag-auto", keywordText: "carta reyes magos", matchType: "NEGATIVE_EXACT", state: "ENABLED" }];
    const plan = planIsolation({ campaigns, keywords, productAds, negatives, records: [] });
    expect(plan.create.map((c) => c.adGroupId)).toEqual(["ag-phrase"]);
  });

  it("removes its own negatives when the exact keyword is no longer active", () => {
    const paused = keywords.map((k) => (k.keywordId === "k1" ? { ...k, state: "PAUSED" } : k));
    const records = [{ negativeKeywordId: "n1", campaignId: "auto", adGroupId: "ag-auto", term: "carta reyes magos", date: "2026-11-25" }];
    const plan = planIsolation({ campaigns, keywords: paused, productAds, negatives: [], records });
    expect(plan.create).toEqual([]);
    expect(plan.remove).toEqual(records);
  });

  it("does nothing when the exact campaign is paused", () => {
    const off = campaigns.map((c) => (c.campaignId === "exact" ? { ...c, state: "PAUSED" } : c));
    expect(planIsolation({ campaigns: off, keywords, productAds, negatives: [], records: [] }).create).toEqual([]);
  });
});

describe("pruneSubstitutes", () => {
  const base = { targetId: "t", adGroupId: "ag", expressionType: "ASIN_SUBSTITUTE_RELATED", bid: 0.2, orders: 0 };
  it("pauses substitutes with ≥ 20 clicks and no sales or ACoS above 1.5 × target", () => {
    const out = pruneSubstitutes(
      [
        { ...base, targetId: "none", spend: 5, sales: 0, clicks: 25 },
        { ...base, targetId: "high", spend: 10, sales: 20, clicks: 40, orders: 1 },
        { ...base, targetId: "ok", spend: 5, sales: 20, clicks: 40, orders: 2 },
        { ...base, targetId: "few", spend: 5, sales: 0, clicks: 10 },
        { ...base, targetId: "close", expressionType: "QUERY_HIGH_REL_MATCHES", spend: 5, sales: 0, clicks: 30 },
      ],
      () => 22
    );
    expect(out.map((o) => o.targetId)).toEqual(["none", "high"]);
  });
});

describe("adGroupTargetAcos", () => {
  it("is min(22 %, 0.8 × spend-weighted break-even), floor 8 %", () => {
    expect(adGroupTargetAcos([{ breakEvenAcos: 40, spend: 10 }])).toBe(22);
    expect(adGroupTargetAcos([{ breakEvenAcos: 20, spend: 10 }])).toBe(16);
    expect(adGroupTargetAcos([{ breakEvenAcos: 20, spend: 30 }, { breakEvenAcos: 40, spend: 10 }])).toBe(20);
    expect(adGroupTargetAcos([{ breakEvenAcos: 1, spend: 10 }])).toBe(8);
    expect(adGroupTargetAcos([{ breakEvenAcos: null, spend: 10 }])).toBe(22);
  });
});

describe("regulate with an own target ACoS", () => {
  it("cuts an entity above its own target even when under 22 %", () => {
    const e = { id: "x", kind: "keyword" as const, label: "x", bid: 0.5, spend: 20, sales: 100, orders: 4, clicks: 60, targetAcos: 14 };
    const r = regulate([e, { ...e, id: "y", targetAcos: undefined }]);
    expect(r.changes.find((c) => c.id === "x")?.newBid).toBeLessThan(0.5);
    expect(r.changes.find((c) => c.id === "y")?.newBid ?? 0.5).toBeGreaterThanOrEqual(0.5);
  });
});
