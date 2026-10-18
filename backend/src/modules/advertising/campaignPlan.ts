/**
 * Profit-first Sponsored Products structure built from scratch per country (spec advertising §10).
 * Pure: candidates and history in, a reviewable plan out. Nothing here talks to Amazon.
 *
 *  - AUTO discovery per product family, ad groups by bid tier (one bid no longer fits 8 € and 90 € products).
 *  - MANUAL·ASIN: competitor product pages that already converted.
 *  - MANUAL·EXACTA: converting search terms, negated exact in the AUTO campaigns (term isolation).
 *  - MARCA: brand terms at a low bid.
 */

export const MIN_UNIT_PROFIT = 3;
export const MIN_CPC = 0.05;
export const MAX_CPC = 1.5;
export const TARGET_ACOS_SHARE = 0.65;
export const PRIOR_CLICKS = 50;
export const MIN_FAMILY_SKUS = 3;
export const MIN_CAMPAIGN_BUDGET = 1;
/** An AUTO campaign needs at least this daily budget; with less, families share one campaign. */
export const MIN_AUTO_BUDGET = 3;
const TIERS = [
  { name: "A", min: 0.3 },
  { name: "B", min: 0.15 },
  { name: "C", min: MIN_CPC },
] as const;
const SHARE = { exact: 0.15, asin: 0.2, brand: 0.05 } as const;

export interface PlanCandidate {
  sku: string;
  asin: string;
  family: string;
  brand: string | null;
  price: number | null;
  unitProfit: number | null;
  breakEvenAcos: number | null;
  /** Stock/Buy Box factor (spec §9); 0 = not advertisable. */
  alpha: number;
  flags: string[];
  /** Ad history in the report window (0 when never advertised). */
  clicks: number;
  sameSkuSales: number;
}

export interface ConvertingTerm {
  text: string;
  isAsin: boolean;
  orders: number;
  acos: number;
  suggestedBid: number;
  /** SKUs that sold through this term's original ad group. */
  skus: string[];
}

export interface AutoTargetingBids {
  close: number;
  loose: number;
  substitutes: number;
  complements: number;
}

export interface PlannedAdGroup {
  name: string;
  defaultBid: number;
  skus: string[];
  keywords: Array<{ text: string; matchType: "EXACT" | "PHRASE"; bid: number }>;
  targets: Array<{ asin: string; bid: number }>;
  /** AUTO only: bid per auto targeting group (0 = paused). */
  autoBids?: AutoTargetingBids;
}

export interface PlannedCampaign {
  name: string;
  targetingType: "AUTO" | "MANUAL";
  dailyBudget: number;
  adGroups: PlannedAdGroup[];
  /** Campaign-level negatives that isolate harvested terms from discovery. */
  negativeKeywords: string[];
  negativeAsins: string[];
}

export interface CampaignPlan {
  country: string;
  dailyBudget: number;
  campaigns: PlannedCampaign[];
  excluded: Array<{ sku: string; reason: string }>;
  pauseOld: Array<{ campaignId: string; name: string }>;
  assumptions: string[];
}

export interface PlanInput {
  country: string;
  prefix: string;
  dailyBudget: number;
  accountCvr: number;
  candidates: PlanCandidate[];
  terms: ConvertingTerm[];
  /** Per auto targeting group, relative performance multiplier from the country's history (1 = average). */
  autoMultipliers: Partial<AutoTargetingBids>;
  brandNames: string[];
  oldEnabledCampaigns: Array<{ campaignId: string; name: string }>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Amazon rejects some characters in names (e.g. "·"): keep letters, digits and basic punctuation. */
export const safeName = (name: string) =>
  name
    .replace(/[^\p{L}\p{N} |\-.,()&/+:_]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
const clampBid = (n: number) => round2(Math.min(MAX_CPC, Math.max(MIN_CPC, n)));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/** Sustainable CPC: smoothed revenue per click × target ACoS × alpha. */
export function sustainableCpc(c: PlanCandidate, accountCvr: number): number | null {
  if (c.price === null || c.breakEvenAcos === null) return null;
  const revenuePerClick = (c.sameSkuSales + PRIOR_CLICKS * c.price * accountCvr) / (c.clicks + PRIOR_CLICKS);
  return round2(revenuePerClick * (c.breakEvenAcos / 100) * TARGET_ACOS_SHARE * c.alpha);
}

function eligibility(c: PlanCandidate, cpc: number | null): string | null {
  if (c.alpha === 0) return c.flags.includes("SIN_BUY_BOX") ? "Sin Buy Box en este país" : "Sin stock FBA";
  if (c.price === null) return "Sin oferta/precio en este país";
  if (c.unitProfit === null) return "Margen incompleto (comisiones o coste)";
  if (c.unitProfit < MIN_UNIT_PROFIT) return `Beneficio por unidad ${c.unitProfit} € < ${MIN_UNIT_PROFIT} €`;
  if (cpc === null || cpc < MIN_CPC) return `CPC sostenible ${cpc ?? "—"} € < ${MIN_CPC} €: no compite`;
  return null;
}

function autoBids(bid: number, m: Partial<AutoTargetingBids>): AutoTargetingBids {
  const at = (k: keyof AutoTargetingBids, def: number) => {
    const mult = m[k] ?? def;
    return mult === 0 ? 0 : clampBid(bid * mult);
  };
  return { close: at("close", 1), substitutes: at("substitutes", 1), loose: at("loose", 0.6), complements: at("complements", 0) };
}

function autoCampaigns(
  input: PlanInput,
  eligible: Array<PlanCandidate & { cpc: number }>,
  maxCampaigns: number,
  exactTerms: string[],
  asinTerms: string[]
): PlannedCampaign[] {
  const byFamily = new Map<string, Array<PlanCandidate & { cpc: number }>>();
  for (const c of eligible) byFamily.set(c.family, [...(byFamily.get(c.family) ?? []), c]);
  // The budget decides how many AUTO campaigns fit; the biggest families keep their own, the rest share
  // one ("Varios"), or a single "Catálogo" when only one fits. Small families never get their own either.
  const capacity = (list: Array<PlanCandidate & { cpc: number }>) => list.reduce((a, c) => a + c.cpc, 0);
  const ranked = [...byFamily].filter(([, l]) => l.length >= MIN_FAMILY_SKUS).sort((a, b) => capacity(b[1]) - capacity(a[1]));
  const own = new Set(maxCampaigns <= 1 ? [] : ranked.slice(0, maxCampaigns - 1).map(([f]) => f));
  const shared = maxCampaigns <= 1 ? "Catálogo" : "Varios";
  const campaigns = new Map<string, Array<PlanCandidate & { cpc: number }>>();
  for (const [family, list] of byFamily) {
    const key = own.has(family) ? family : shared;
    campaigns.set(key, [...(campaigns.get(key) ?? []), ...list]);
  }
  return [...campaigns].map(([family, rawList]) => {
    // Inside a shared campaign, families with < 3 SKUs pool into "Otros": single-SKU ad groups never gather data.
    const counts = new Map<string, number>();
    for (const c of rawList) counts.set(c.family, (counts.get(c.family) ?? 0) + 1);
    const list = rawList.map((c) => ((counts.get(c.family) ?? 0) < MIN_FAMILY_SKUS ? { ...c, family: "Otros" } : c));
    const families = [...new Set(list.map((c) => c.family))];
    const groups: PlannedAdGroup[] = [];
    for (const fam of families) {
      TIERS.forEach((tier, i) => {
        const upper = i === 0 ? Number.POSITIVE_INFINITY : TIERS[i - 1].min;
        const members = list.filter((c) => c.family === fam && c.cpc >= tier.min && c.cpc < upper);
        if (!members.length) return;
        const bid = clampBid(median(members.map((c) => c.cpc)));
        const name = families.length > 1 ? `${fam} | Puja ${tier.name}` : `Puja ${tier.name}`;
        groups.push({ name, defaultBid: bid, skus: members.map((c) => c.sku), keywords: [], targets: [], autoBids: autoBids(bid, input.autoMultipliers) });
      });
    }
    return {
      name: `${input.prefix} | ${input.country} | AUTO | ${family}`,
      targetingType: "AUTO" as const,
      dailyBudget: 0,
      negativeKeywords: exactTerms,
      negativeAsins: asinTerms,
      adGroups: groups,
    };
  });
}

function manualCampaign(name: string, groups: PlannedAdGroup[]): PlannedCampaign | null {
  const nonEmpty = groups.filter((g) => g.skus.length > 0 && (g.keywords.length > 0 || g.targets.length > 0));
  return nonEmpty.length ? { name, targetingType: "MANUAL", dailyBudget: 0, adGroups: nonEmpty, negativeKeywords: [], negativeAsins: [] } : null;
}

const manualShare = (c: PlannedCampaign) =>
  c.name.endsWith("| EXACTA") ? SHARE.exact : c.name.endsWith("| ASIN") ? SHARE.asin : c.name.endsWith("| MARCA") ? SHARE.brand : 0;

/**
 * Splits the daily budget: fixed shares for manual campaigns, the rest by AUTO spend capacity, with
 * Amazon's 1 € minimum per campaign; AUTO budgets give back any excess so the total stays on budget.
 */
function allocateBudget(campaigns: PlannedCampaign[], total: number, cpcBySku: Map<string, number>): PlannedCampaign[] {
  const fixed = campaigns.reduce((a, c) => a + manualShare(c), 0);
  const capacity = (c: PlannedCampaign) => c.adGroups.flatMap((g) => g.skus).reduce((a, s) => a + (cpcBySku.get(s) ?? 0), 0);
  const autos = campaigns.filter((c) => c.targetingType === "AUTO");
  const totalCapacity = autos.reduce((a, c) => a + capacity(c), 0) || 1;
  const raw = campaigns.map((c) =>
    Math.max(MIN_CAMPAIGN_BUDGET, c.targetingType === "AUTO" ? total * (1 - fixed) * (capacity(c) / totalCapacity) : total * manualShare(c))
  );
  let excess = raw.reduce((a, b) => a + b, 0) - total;
  const budgets = [...raw];
  for (let i = 0; i < campaigns.length && excess > 0.005; i++) {
    if (campaigns[i].targetingType !== "AUTO") continue;
    const give = Math.min(excess, budgets[i] - MIN_CAMPAIGN_BUDGET);
    budgets[i] -= give;
    excess -= give;
  }
  return campaigns.map((c, i) => ({ ...c, dailyBudget: round2(budgets[i]) }));
}

export function buildCampaignPlan(input: PlanInput): CampaignPlan {
  const excluded: CampaignPlan["excluded"] = [];
  const eligible: Array<PlanCandidate & { cpc: number }> = [];
  for (const c of input.candidates) {
    const cpc = sustainableCpc(c, input.accountCvr);
    const reason = eligibility(c, cpc);
    if (reason) excluded.push({ sku: c.sku, reason });
    else eligible.push({ ...c, cpc: cpc as number });
  }
  const eligibleSkus = new Set(eligible.map((c) => c.sku));
  const cpcBySku = new Map(eligible.map((c) => [c.sku, c.cpc]));
  const withSkus = (t: ConvertingTerm) => ({ ...t, skus: t.skus.filter((s) => eligibleSkus.has(s)) });
  const terms = input.terms.map(withSkus).filter((t) => t.skus.length > 0);
  const isBrandTerm = (t: ConvertingTerm) => input.brandNames.some((b) => t.text.toLowerCase().includes(b.toLowerCase()));
  // Brand searches belong to the brand campaign only (no competition between campaigns for them).
  const brandTerms = terms.filter((t) => !t.isAsin && isBrandTerm(t));
  const kwTerms = terms.filter((t) => !t.isAsin && !isBrandTerm(t));
  const asinTerms = terms.filter((t) => t.isAsin);

  const brandSkus = eligible.filter((c) => c.brand && input.brandNames.some((b) => b.toLowerCase() === c.brand?.toLowerCase())).map((c) => c.sku);
  const exact = manualCampaign(
    `${input.prefix} | ${input.country} | MANUAL | EXACTA`,
    kwTerms.map((t) => ({ name: safeName(`Exacta | ${t.text}`), defaultBid: t.suggestedBid, skus: t.skus, keywords: [{ text: t.text, matchType: "EXACT", bid: clampBid(t.suggestedBid) }], targets: [] }))
  );
  const asin = manualCampaign(
    `${input.prefix} | ${input.country} | MANUAL | ASIN`,
    asinTerms.map((t) => ({ name: `ASIN | ${t.text}`, defaultBid: t.suggestedBid, skus: t.skus, keywords: [], targets: [{ asin: t.text, bid: clampBid(t.suggestedBid) }] }))
  );
  const brandBid = clampBid(median(brandSkus.map((s) => cpcBySku.get(s) ?? MIN_CPC)) * 0.5);
  const brand = manualCampaign(`${input.prefix} | ${input.country} | MARCA`, [
    {
      name: "Marca",
      defaultBid: brandBid,
      skus: [...new Set([...brandSkus, ...brandTerms.flatMap((t) => t.skus)])],
      keywords: [
        ...input.brandNames.map((b) => ({ text: b.toLowerCase(), matchType: "PHRASE" as const, bid: brandBid })),
        ...brandTerms.map((t) => ({ text: t.text, matchType: "EXACT" as const, bid: clampBid(t.suggestedBid) })),
      ],
      targets: [],
    },
  ]);

  const manual = [exact, asin, brand].filter((c): c is PlannedCampaign => c !== null);
  const autoBudget = input.dailyBudget - manual.reduce((a, c) => a + Math.max(MIN_CAMPAIGN_BUDGET, input.dailyBudget * manualShare(c)), 0);
  const maxAuto = Math.max(1, Math.floor(autoBudget / MIN_AUTO_BUDGET));
  const campaigns = [...autoCampaigns(input, eligible, maxAuto, [...kwTerms, ...brandTerms].map((t) => t.text), asinTerms.map((t) => t.text)), ...manual];
  return {
    country: input.country,
    dailyBudget: input.dailyBudget,
    campaigns: allocateBudget(campaigns, input.dailyBudget, cpcBySku),
    excluded,
    pauseOld: input.oldEnabledCampaigns,
    assumptions: [
      `CPC sostenible = ingreso por clic suavizado (conversión país ${(input.accountCvr * 100).toFixed(1)} %, ${PRIOR_CLICKS} clics de prior) × ${TARGET_ACOS_SHARE * 100} % del ACoS de equilibrio × factor stock/Buy Box`,
      `Grupos por nivel de puja: A ≥ ${TIERS[0].min} €, B ≥ ${TIERS[1].min} €, C ≥ ${TIERS[2].min} €; puja del grupo = mediana de sus SKUs (máx. ${MAX_CPC} €)`,
      `Máximo ${maxAuto} campaña(s) AUTO (≥ ${MIN_AUTO_BUDGET} €/día cada una); las familias restantes comparten campaña y conservan su nombre en el grupo`,
      "Todo se crea EN PAUSA; las campañas antiguas solo se pausan al activar las nuevas",
    ],
  };
}
