import type { AdsWriter } from "./campaignApply";
import { safeName } from "./campaignPlan";
import type { HarvestCandidate } from "./harvest";
import type { NegativeCandidate } from "./negatives";

/**
 * Applies an approved keyword proposal in Amazon Ads (spec advertising §12):
 *  - NEGATIVE_EXACT / NEGATIVE_EXACT_ORIGIN → negative exact keyword in the term's ad group
 *  - NEGATIVE_PRODUCT_TARGET → negative product target in the term's ad group
 *  - HARVEST_EXACT / HARVEST_PRODUCT_TARGET → new ad group in the country's MANUAL EXACTA / ASIN
 *    campaign with the SKUs that sold, the keyword/target at the suggested bid, and the origin negative
 *  - BID_DOWN → the existing exact keyword's bid to the suggested one
 * Returns a human explanation of what was done.
 */

const MT = {
  negKeyword: "application/vnd.spNegativeKeyword.v3+json",
  negTarget: "application/vnd.spNegativeTargetingClause.v3+json",
  adGroup: "application/vnd.spAdGroup.v3+json",
  productAd: "application/vnd.spProductAd.v3+json",
  keyword: "application/vnd.spKeyword.v3+json",
  target: "application/vnd.spTargetingClause.v3+json",
} as const;

export type ApprovedProposal = NegativeCandidate | HarvestCandidate;

export interface ProposalContext {
  /** campaignId of "PF | <CC> | MANUAL | EXACTA" / "… | ASIN", if they exist. */
  exactCampaignId?: string;
  asinCampaignId?: string;
  /** SKUs to advertise for a harvested term (sellers of its origin ad group). */
  sellers: string[];
}

type MultiStatus = { success?: Array<Record<string, unknown> & { index: number }>; error?: Array<{ index: number; errors?: unknown }> };

async function createOne(ads: AdsWriter, path: string, mt: string, wrapper: string, item: Record<string, unknown>, idField: string): Promise<string> {
  const res = await ads.post<Record<string, MultiStatus>>(path, mt, { [wrapper]: [item] });
  const ok = res[wrapper]?.success?.[0];
  if (ok) return String(ok[idField] ?? "");
  const err = JSON.stringify(res[wrapper]?.error?.[0]?.errors ?? "error");
  if (/DUPLICATE|already exists/i.test(err)) return "existente";
  throw new Error(`Amazon rechazó ${wrapper}: ${err.slice(0, 300)}`);
}

const negativeKeyword = (ads: AdsWriter, campaignId: string, adGroupId: string, text: string) =>
  createOne(ads, "/sp/negativeKeywords", MT.negKeyword, "negativeKeywords", { campaignId, adGroupId, keywordText: text, matchType: "NEGATIVE_EXACT", state: "ENABLED" }, "negativeKeywordId");

const negativeTarget = (ads: AdsWriter, campaignId: string, adGroupId: string, asin: string) =>
  createOne(ads, "/sp/negativeTargets", MT.negTarget, "negativeTargetingClauses", { campaignId, adGroupId, expression: [{ type: "ASIN_SAME_AS", value: asin }], state: "ENABLED" }, "targetId");

export async function applyProposal(ads: AdsWriter, p: ApprovedProposal, ctx: ProposalContext): Promise<string> {
  switch (p.type) {
    case "NEGATIVE_EXACT":
    case "NEGATIVE_EXACT_ORIGIN":
      await negativeKeyword(ads, p.campaignId, p.adGroupId, p.text);
      return `Negativa exacta «${p.text}» añadida en el grupo ${p.adGroupId}`;
    case "NEGATIVE_PRODUCT_TARGET":
      await negativeTarget(ads, p.campaignId, p.adGroupId, p.text);
      return `ASIN ${p.text} excluido en el grupo ${p.adGroupId}`;
    case "BID_DOWN": {
      const res = await ads.post<{ keywords?: Array<{ keywordId: string; keywordText: string }> }>("/sp/keywords/list", MT.keyword, {
        adGroupIdFilter: { include: [p.adGroupId] },
        stateFilter: { include: ["ENABLED"] },
        maxResults: 1000,
      });
      const kw = res.keywords?.find((k) => k.keywordText.toLowerCase() === p.text.toLowerCase());
      if (!kw) throw new Error(`No se encontró la keyword «${p.text}» en el grupo ${p.adGroupId}`);
      await ads.put("/sp/keywords", MT.keyword, { keywords: [{ keywordId: kw.keywordId, bid: p.suggestedBid }] });
      return `Puja de «${p.text}» bajada a ${p.suggestedBid} €`;
    }
    case "HARVEST_EXACT":
    case "HARVEST_PRODUCT_TARGET": {
      const exact = p.type === "HARVEST_EXACT";
      const campaignId = exact ? ctx.exactCampaignId : ctx.asinCampaignId;
      if (!campaignId) throw new Error(`No existe la campaña ${exact ? "MANUAL | EXACTA" : "MANUAL | ASIN"} del país`);
      if (!ctx.sellers.length) throw new Error("Ningún SKU elegible que haya vendido con este término");
      const adGroupId = await createOne(
        ads,
        "/sp/adGroups",
        MT.adGroup,
        "adGroups",
        { campaignId, name: safeName(`${exact ? "Exacta" : "ASIN"} | ${p.text}`), state: "ENABLED", defaultBid: p.suggestedBid },
        "adGroupId"
      );
      if (adGroupId === "existente") throw new Error("Ya existe un grupo para este término");
      for (const sku of ctx.sellers) await createOne(ads, "/sp/productAds", MT.productAd, "productAds", { campaignId, adGroupId, sku, state: "ENABLED" }, "adId");
      if (exact) {
        await createOne(ads, "/sp/keywords", MT.keyword, "keywords", { campaignId, adGroupId, keywordText: p.text, matchType: "EXACT", bid: p.suggestedBid, state: "ENABLED" }, "keywordId");
        await negativeKeyword(ads, p.campaignId, p.adGroupId, p.text);
      } else {
        await createOne(
          ads,
          "/sp/targets",
          MT.target,
          "targetingClauses",
          { campaignId, adGroupId, expression: [{ type: "ASIN_SAME_AS", value: p.text }], expressionType: "MANUAL", bid: p.suggestedBid, state: "ENABLED" },
          "targetId"
        );
        await negativeTarget(ads, p.campaignId, p.adGroupId, p.text);
      }
      return `«${p.text}» graduado a ${exact ? "Exacta" : "targeting de producto"} con ${ctx.sellers.length} SKU a ${p.suggestedBid} € y excluido en su grupo de origen`;
    }
  }
}
