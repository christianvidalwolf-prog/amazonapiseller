import { describe, expect, it } from "vitest";
import { type AdsWriter, CampaignPlanApplier } from "./campaignApply";
import type { CampaignPlan } from "./campaignPlan";

const plan: CampaignPlan = {
  country: "ES",
  dailyBudget: 10,
  excluded: [],
  assumptions: [],
  pauseOld: [{ campaignId: "OLD", name: "FBA sellers" }],
  campaigns: [
    {
      name: "PF | ES | AUTO | Hogar",
      targetingType: "AUTO",
      dailyBudget: 7,
      negativeKeywords: ["mimbre"],
      negativeAsins: [],
      adGroups: [{ name: "Puja B", defaultBid: 0.2, skus: ["A1", "A2"], keywords: [], targets: [], autoBids: { close: 0.2, loose: 0.12, substitutes: 0.2, complements: 0 } }],
    },
    {
      name: "PF | ES | MANUAL | EXACTA",
      targetingType: "MANUAL",
      dailyBudget: 3,
      negativeKeywords: [],
      negativeAsins: [],
      adGroups: [{ name: "Exacta | mimbre", defaultBid: 0.21, skus: ["A1"], keywords: [{ text: "mimbre", matchType: "EXACT", bid: 0.21 }], targets: [] }],
    },
  ],
};

/** Amazon stand-in: assigns ids, knows which campaigns already exist, and returns 4 auto targets per ad group. */
function fakeAmazon(
  existingCampaigns: Record<string, string> = {},
  existingGroups: Record<string, string> = {},
  existingAds: Array<{ adId: string; sku: string; state: string }> = [],
  existingNegatives: Array<{ keywordId: string; keywordText: string }> = []
) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  let id = 0;
  const writer: AdsWriter = {
    async post<T>(path: string, _mt: string, body: unknown): Promise<T> {
      calls.push({ method: "POST", path, body: body as Record<string, unknown> });
      if (path === "/sp/campaigns/list") return { campaigns: Object.entries(existingCampaigns).map(([name, campaignId]) => ({ name, campaignId })) } as T;
      if (path === "/sp/adGroups/list") return { adGroups: Object.entries(existingGroups).map(([name, adGroupId]) => ({ name, adGroupId })) } as T;
      if (path === "/sp/productAds/list") return { productAds: existingAds } as T;
      if (path === "/sp/campaignNegativeKeywords/list") return { campaignNegativeKeywords: existingNegatives } as T;
      if (path === "/sp/campaignNegativeTargets/list") return { campaignNegativeTargetingClauses: [] } as T;
      if (path.endsWith("/delete")) return {} as T;
      if (path === "/sp/targets/list") {
        const types = ["QUERY_HIGH_REL_MATCHES", "QUERY_BROAD_REL_MATCHES", "ASIN_SUBSTITUTE_RELATED", "ASIN_ACCESSORY_RELATED"];
        return { targetingClauses: types.map((t, i) => ({ targetId: `T${i}`, expression: [{ type: t }] })) } as T;
      }
      const [wrapper, items] = Object.entries(body as Record<string, unknown[]>)[0];
      const idField = { campaigns: "campaignId", adGroups: "adGroupId" }[wrapper] ?? "id";
      return { [wrapper]: { success: items.map((_, index) => ({ index, [idField]: `ID${++id}` })) } } as T;
    },
    async put<T>(path: string, _mt: string, body: unknown): Promise<T> {
      calls.push({ method: "PUT", path, body: body as Record<string, unknown> });
      return {} as T;
    },
  };
  return { writer, calls };
}

describe("CampaignPlanApplier", () => {
  it("dry run only lists existing campaigns and records the intended operations", async () => {
    const { writer, calls } = fakeAmazon();
    const log = await new CampaignPlanApplier(writer, false, "2026-10-19").applyPlan(plan);
    expect(calls.map((c) => c.path)).toEqual(["/sp/campaigns/list"]);
    expect(log.map((l) => l.action)).toEqual([
      "crear campaigns",
      "crear campaigns",
      "crear adGroups",
      "crear productAds",
      "crear productAds",
      "pujas automáticas",
      "crear campaignNegativeKeywords",
      "crear adGroups",
      "crear productAds",
      "crear keywords",
    ]);
  });

  it("creates campaigns PAUSED, then ad groups, ads, keywords, auto bids and campaign negatives", async () => {
    const { writer, calls } = fakeAmazon();
    const log = await new CampaignPlanApplier(writer, true, "2026-10-19").applyPlan(plan);
    const created = calls.find((c) => c.path === "/sp/campaigns")?.body.campaigns as Array<Record<string, unknown>>;
    expect(created.map((c) => [c.name, c.state, c.targetingType])).toEqual([
      ["PF | ES | AUTO | Hogar", "PAUSED", "AUTO"],
      ["PF | ES | MANUAL | EXACTA", "PAUSED", "MANUAL"],
    ]);
    const autoUpdate = calls.find((c) => c.method === "PUT" && c.path === "/sp/targets")?.body.targetingClauses;
    expect(autoUpdate).toEqual([
      { targetId: "T0", bid: 0.2, state: "ENABLED" },
      { targetId: "T1", bid: 0.12, state: "ENABLED" },
      { targetId: "T2", bid: 0.2, state: "ENABLED" },
      { targetId: "T3", state: "PAUSED" },
    ]);
    expect(log.filter((l) => l.error)).toEqual([]);
  });

  it("is idempotent: an existing campaign is not created again", async () => {
    const { writer, calls } = fakeAmazon({ "PF | ES | AUTO | Hogar": "C1" });
    await new CampaignPlanApplier(writer, true, "2026-10-19").applyPlan(plan);
    const created = calls.find((c) => c.path === "/sp/campaigns")?.body.campaigns as Array<Record<string, unknown>>;
    expect(created.map((c) => c.name)).toEqual(["PF | ES | MANUAL | EXACTA"]);
  });

  it("activation enables the new campaigns and pauses the old ones; rollback reverses it", async () => {
    const { writer, calls } = fakeAmazon({ "PF | ES | AUTO | Hogar": "C1", "PF | ES | MANUAL | EXACTA": "C2" });
    await new CampaignPlanApplier(writer, true, "2026-10-19").setStates(plan, "activate");
    expect(calls.at(-1)?.body.campaigns).toEqual([
      { campaignId: "C1", state: "ENABLED" },
      { campaignId: "C2", state: "ENABLED" },
      { campaignId: "OLD", state: "PAUSED" },
    ]);
    await new CampaignPlanApplier(writer, true, "2026-10-19").setStates(plan, "rollback");
    expect(calls.at(-1)?.body.campaigns).toEqual([
      { campaignId: "C1", state: "PAUSED" },
      { campaignId: "C2", state: "PAUSED" },
      { campaignId: "OLD", state: "ENABLED" },
    ]);
  });

  it("reconciles an existing campaign: budget, ad group bid, ads in/out and ad groups out of the plan", async () => {
    const { writer, calls } = fakeAmazon(
      { "PF | ES | AUTO | Hogar": "C1", "PF | ES | MANUAL | EXACTA": "C2" },
      { "Puja B": "G1", "Puja A": "G0" },
      [
        { adId: "AD1", sku: "A1", state: "ENABLED" },
        { adId: "AD9", sku: "OLD9", state: "ENABLED" },
      ]
    );
    await new CampaignPlanApplier(writer, true, "2026-10-19").applyPlan(plan);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.find((c) => c.path === "/sp/campaigns")?.body.campaigns).toEqual([
      { campaignId: "C1", budget: { budgetType: "DAILY", budget: 7 } },
      { campaignId: "C2", budget: { budgetType: "DAILY", budget: 3 } },
    ]);
    expect(puts.find((c) => c.path === "/sp/adGroups")?.body.adGroups).toEqual([
      { adGroupId: "G1", state: "ENABLED", defaultBid: 0.2 },
      { adGroupId: "G0", state: "PAUSED" },
    ]);
    expect(puts.find((c) => c.path === "/sp/productAds")?.body.productAds).toEqual([{ adId: "AD9", state: "PAUSED" }]);
    const createdInC1 = calls
      .filter((c) => c.path === "/sp/productAds" && c.method === "POST")
      .flatMap((c) => c.body.productAds as Array<{ sku: string; campaignId: string }>)
      .filter((a) => a.campaignId === "C1");
    // A1 already exists in C1 (kept enabled), A2 is missing (created).
    expect(createdInC1.map((a) => a.sku)).toEqual(["A2"]);
  });

  it("never duplicates campaign negatives and deletes extra copies", async () => {
    const { writer, calls } = fakeAmazon({ "PF | ES | AUTO | Hogar": "C1" }, {}, [], [
      { keywordId: "N1", keywordText: "mimbre" },
      { keywordId: "N2", keywordText: "mimbre" },
    ]);
    await new CampaignPlanApplier(writer, true, "2026-10-19").applyPlan(plan);
    expect(calls.find((c) => c.path === "/sp/campaignNegativeKeywords/delete")?.body).toEqual({ campaignNegativeKeywordIdFilter: { include: ["N2"] } });
    expect(calls.some((c) => c.path === "/sp/campaignNegativeKeywords" && c.method === "POST")).toBe(false);
  });
});

