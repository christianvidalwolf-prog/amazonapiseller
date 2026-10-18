import type { CampaignPlan, PlannedAdGroup, PlannedCampaign } from "./campaignPlan";

/**
 * Creates a campaign plan in Amazon Ads (Sponsored Products v3), spec advertising §10.
 * - Campaigns are always created PAUSED; nothing serves until `activate` runs.
 * - Idempotent by name: re-running resumes a partial creation without duplicating campaigns or ad groups.
 * - Dry run unless `apply` is true: every call is only recorded.
 * Activation enables the new campaigns and pauses the old ones together; rollback reverses it.
 */

/** The slice of Amazon Ads v3 the executor uses (AdsApiClient.request in production, a fake in tests). */
export interface AdsWriter {
  post<T>(path: string, mediaType: string, body: unknown): Promise<T>;
  put<T>(path: string, mediaType: string, body: unknown): Promise<T>;
}

export interface ApplyLogEntry {
  action: string;
  entity: string;
  detail: string;
  id?: string;
  error?: string;
}

interface MultiStatus {
  success?: Array<Record<string, unknown> & { index: number }>;
  error?: Array<{ index: number; errors?: Array<{ errorType?: string; errorValue?: unknown }> }>;
}

const MT = {
  campaign: "application/vnd.spCampaign.v3+json",
  adGroup: "application/vnd.spAdGroup.v3+json",
  productAd: "application/vnd.spProductAd.v3+json",
  keyword: "application/vnd.spKeyword.v3+json",
  target: "application/vnd.spTargetingClause.v3+json",
  campaignNegKeyword: "application/vnd.spCampaignNegativeKeyword.v3+json",
  campaignNegTarget: "application/vnd.spCampaignNegativeTargetingClause.v3+json",
} as const;
const CHUNK = 100;

/** Amazon's auto targeting expressions, mapped to the plan's bid names. */
const AUTO_EXPRESSIONS: Record<string, keyof NonNullable<PlannedAdGroup["autoBids"]>> = {
  QUERY_HIGH_REL_MATCHES: "close",
  QUERY_BROAD_REL_MATCHES: "loose",
  ASIN_SUBSTITUTE_RELATED: "substitutes",
  ASIN_ACCESSORY_RELATED: "complements",
};

const chunks = <T>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));
const errorText = (e: MultiStatus["error"], index: number) => JSON.stringify(e?.find((x) => x.index === index)?.errors ?? "error").slice(0, 300);
/** Duplicates of entities that already exist are success for an idempotent run. */
const isDuplicate = (e: MultiStatus["error"], index: number) => /DUPLICATE|already exists/i.test(errorText(e, index));

export class CampaignPlanApplier {
  readonly log: ApplyLogEntry[] = [];
  private fakeId = 0;

  constructor(
    private readonly ads: AdsWriter,
    private readonly apply: boolean,
    private readonly startDate: string
  ) {}

  private record(entry: ApplyLogEntry): void {
    this.log.push(entry);
  }

  /** POST a batch; returns the created ids by input index (fake ids in dry run). */
  private async create(path: string, mediaType: string, wrapper: string, items: Array<Record<string, unknown>>, idField: string, label: (i: number) => string): Promise<Array<string | null>> {
    const ids: Array<string | null> = new Array(items.length).fill(null);
    let offset = 0;
    for (const part of chunks(items)) {
      if (!this.apply) {
        part.forEach((_, i) => {
          ids[offset + i] = `dry-${++this.fakeId}`;
          this.record({ action: `crear ${wrapper}`, entity: label(offset + i), detail: "simulacro" });
        });
      } else {
        const res = await this.ads.post<Record<string, MultiStatus>>(path, mediaType, { [wrapper]: part });
        const status = res[wrapper] ?? {};
        for (const ok of status.success ?? []) {
          ids[offset + ok.index] = String(ok[idField] ?? "");
          this.record({ action: `crear ${wrapper}`, entity: label(offset + ok.index), detail: "ok", id: ids[offset + ok.index] ?? undefined });
        }
        for (const err of status.error ?? []) {
          const duplicate = isDuplicate(status.error, err.index);
          this.record({ action: `crear ${wrapper}`, entity: label(offset + err.index), detail: duplicate ? "ya existía" : "error", error: duplicate ? undefined : errorText(status.error, err.index) });
        }
      }
      offset += part.length;
    }
    return ids;
  }

  private async listByName(path: string, mediaType: string, wrapper: string, filter: Record<string, unknown>, nameField = "name", idField = "campaignId"): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    let nextToken: string | undefined;
    do {
      const res = await this.ads.post<Record<string, unknown> & { nextToken?: string }>(path, mediaType, { ...filter, maxResults: 1000, ...(nextToken ? { nextToken } : {}) });
      for (const item of (res[wrapper] as Array<Record<string, unknown>>) ?? []) out.set(String(item[nameField]), String(item[idField]));
      nextToken = res.nextToken;
    } while (nextToken);
    return out;
  }

  async applyPlan(plan: CampaignPlan): Promise<ApplyLogEntry[]> {
    const existing = await this.listByName("/sp/campaigns/list", MT.campaign, "campaigns", { stateFilter: { include: ["ENABLED", "PAUSED"] } });
    const missing = plan.campaigns.filter((c) => !existing.has(c.name));
    const ids = await this.create(
      "/sp/campaigns",
      MT.campaign,
      "campaigns",
      missing.map((c) => ({
        name: c.name,
        targetingType: c.targetingType,
        state: "PAUSED",
        dynamicBidding: { strategy: "LEGACY_FOR_SALES" },
        budget: { budgetType: "DAILY", budget: c.dailyBudget },
        startDate: this.startDate,
      })),
      "campaignId",
      (i) => missing[i].name
    );
    missing.forEach((c, i) => {
      if (ids[i]) existing.set(c.name, ids[i] as string);
    });
    for (const campaign of plan.campaigns) {
      const campaignId = existing.get(campaign.name);
      if (campaignId) await this.applyCampaign(campaign, campaignId);
    }
    return this.log;
  }

  private async applyCampaign(c: PlannedCampaign, campaignId: string): Promise<void> {
    const known = campaignId.startsWith("dry-")
      ? new Map<string, string>()
      : await this.listByName("/sp/adGroups/list", MT.adGroup, "adGroups", { campaignIdFilter: { include: [campaignId] } }, "name", "adGroupId");
    const missing = c.adGroups.filter((g) => !known.has(g.name));
    const ids = await this.create(
      "/sp/adGroups",
      MT.adGroup,
      "adGroups",
      missing.map((g) => ({ campaignId, name: g.name, state: "ENABLED", defaultBid: g.defaultBid })),
      "adGroupId",
      (i) => `${c.name} › ${missing[i].name}`
    );
    missing.forEach((g, i) => {
      if (ids[i]) known.set(g.name, ids[i] as string);
    });
    for (const g of c.adGroups) {
      const adGroupId = known.get(g.name);
      if (!adGroupId) continue;
      const where = `${c.name} › ${g.name}`;
      await this.create("/sp/productAds", MT.productAd, "productAds", g.skus.map((sku) => ({ campaignId, adGroupId, sku, state: "ENABLED" })), "adId", (i) => `${where} › ${g.skus[i]}`);
      if (g.keywords.length) {
        await this.create(
          "/sp/keywords",
          MT.keyword,
          "keywords",
          g.keywords.map((k) => ({ campaignId, adGroupId, keywordText: k.text, matchType: k.matchType, bid: k.bid, state: "ENABLED" })),
          "keywordId",
          (i) => `${where} › "${g.keywords[i].text}"`
        );
      }
      if (g.targets.length) {
        await this.create(
          "/sp/targets",
          MT.target,
          "targetingClauses",
          g.targets.map((t) => ({ campaignId, adGroupId, expression: [{ type: "ASIN_SAME_AS", value: t.asin }], expressionType: "MANUAL", bid: t.bid, state: "ENABLED" })),
          "targetId",
          (i) => `${where} › ASIN ${g.targets[i].asin}`
        );
      }
      if (g.autoBids) await this.setAutoBids(adGroupId, g.autoBids, where);
    }
    if (c.negativeKeywords.length) {
      await this.create(
        "/sp/campaignNegativeKeywords",
        MT.campaignNegKeyword,
        "campaignNegativeKeywords",
        c.negativeKeywords.map((text) => ({ campaignId, keywordText: text, matchType: "NEGATIVE_EXACT", state: "ENABLED" })),
        "campaignNegativeKeywordId",
        (i) => `${c.name} › negativa "${c.negativeKeywords[i]}"`
      );
    }
    if (c.negativeAsins.length) {
      await this.create(
        "/sp/campaignNegativeTargets",
        MT.campaignNegTarget,
        "campaignNegativeTargetingClauses",
        c.negativeAsins.map((asin) => ({ campaignId, expression: [{ type: "ASIN_SAME_AS", value: asin }], state: "ENABLED" })),
        "targetId",
        (i) => `${c.name} › negativa ASIN ${c.negativeAsins[i]}`
      );
    }
  }

  /** Amazon creates the 4 auto targeting clauses with the ad group; set their bids (0 = pause). */
  private async setAutoBids(adGroupId: string, bids: NonNullable<PlannedAdGroup["autoBids"]>, where: string): Promise<void> {
    if (!this.apply) {
      this.record({ action: "pujas automáticas", entity: where, detail: `cercana ${bids.close} · amplia ${bids.loose} · sustitutos ${bids.substitutes} · complementos ${bids.complements} (simulacro)` });
      return;
    }
    const res = await this.ads.post<{ targetingClauses?: Array<{ targetId: string; expression?: Array<{ type: string }> }> }>("/sp/targets/list", MT.target, {
      adGroupIdFilter: { include: [adGroupId] },
      maxResults: 100,
    });
    const updates = (res.targetingClauses ?? [])
      .map((t) => {
        const key = AUTO_EXPRESSIONS[t.expression?.[0]?.type ?? ""];
        if (!key) return null;
        return bids[key] > 0 ? { targetId: t.targetId, bid: bids[key], state: "ENABLED" } : { targetId: t.targetId, state: "PAUSED" };
      })
      .filter((u): u is NonNullable<typeof u> => u !== null);
    if (!updates.length) {
      this.record({ action: "pujas automáticas", entity: where, detail: "error", error: "Amazon no devolvió los targets automáticos del grupo" });
      return;
    }
    await this.ads.put("/sp/targets", MT.target, { targetingClauses: updates });
    this.record({ action: "pujas automáticas", entity: where, detail: `ok (${updates.length} targets)` });
  }

  /** Enables the plan's campaigns and pauses the old enabled ones (or the reverse for rollback). */
  async setStates(plan: CampaignPlan, mode: "activate" | "rollback"): Promise<ApplyLogEntry[]> {
    const existing = await this.listByName("/sp/campaigns/list", MT.campaign, "campaigns", { stateFilter: { include: ["ENABLED", "PAUSED"] } });
    const newer = plan.campaigns.map((c) => existing.get(c.name)).filter((id): id is string => Boolean(id));
    const updates = [
      ...newer.map((campaignId) => ({ campaignId, state: mode === "activate" ? "ENABLED" : "PAUSED" })),
      ...plan.pauseOld.map((c) => ({ campaignId: c.campaignId, state: mode === "activate" ? "PAUSED" : "ENABLED" })),
    ];
    for (const part of chunks(updates)) {
      if (this.apply) await this.ads.put("/sp/campaigns", MT.campaign, { campaigns: part });
      for (const u of part) this.record({ action: mode === "activate" ? "activar" : "deshacer", entity: u.campaignId, detail: `${u.state}${this.apply ? "" : " (simulacro)"}` });
    }
    return this.log;
  }
}
