import type { CampaignPlan, PlannedCampaign } from "./campaignPlan";

/**
 * Single-product launch from a keyword seed (spec advertising §13). Pure: the seed in, a reviewable
 * CampaignPlan out (created by CampaignPlanApplier, always PAUSED), plus the checks that gate it:
 * bid caps, ACoS target below break-even, FBA stock before activation and the TACoS budget cap.
 */

/** No seed may raise its bid cap above this, whatever it says. */
export const ABSOLUTE_MAX_BID = 1.0;
/** Amazon's minimum Sponsored Products bid in the EU marketplaces. */
export const MIN_BID = 0.02;
export const LAUNCH_KINDS = ["Auto", "Exact", "Phrase", "Marca"] as const;
export type LaunchKind = (typeof LAUNCH_KINDS)[number];
/** Optional fifth campaign: product targeting (competitor ASINs and categories). */
export const ASIN_KIND = "ASIN";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface SeedKeyword {
  text: string;
  bid: number;
  /** Marca only: Exact and Phrase campaigns take their match type from the campaign. */
  matchType?: "EXACT" | "PHRASE";
}

interface SeedCampaign {
  dailyBudget: number;
  defaultBid: number;
  keywords?: SeedKeyword[];
  autoBids?: { close: number; loose: number; substitutes: number; complements: number };
}

/** One product target: a competitor ASIN or a browse category id. */
export interface SeedTarget {
  asin?: string;
  category?: string;
  bid: number;
}

interface SeedAsinCampaign {
  dailyBudget: number;
  defaultBid: number;
  targets: SeedTarget[];
}

export interface LaunchSeed {
  status?: string;
  family: string;
  product?: string;
  country: string;
  marketplaceId: string;
  asin: string;
  skus: { fba: string; fbm?: string };
  economics: { priceGross: number; breakEvenAcos: number; targetAcos: number; maxTacos: number };
  bidCaps: { real: number; absolute: number };
  minFbaUnits: number;
  /** Launch exception approved by the user: until this date (YYYY-MM-DD) the TACoS cap does not block activation. */
  tacosExceptionUntil?: string;
  minClicksForBidChange: number;
  /** Last day (YYYY-MM-DD) the campaigns serve: Amazon stops them on its own after it (seasonal products). */
  endDate?: string;
  campaigns: Record<LaunchKind, SeedCampaign> & { Asin?: SeedAsinCampaign };
  negatives: { all: string[]; isolateExactIn: LaunchKind[] };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const norm = (t: string) => t.trim().toLowerCase();

/** Shape check only (types and required fields); business rules are in validateLaunchSeed. */
export function parseLaunchSeed(raw: unknown): LaunchSeed {
  const missing: string[] = [];
  if (!isObj(raw)) throw new Error("Seed inválido: no es un objeto JSON");
  for (const k of ["family", "country", "marketplaceId", "asin"]) if (typeof raw[k] !== "string" || !raw[k]) missing.push(k);
  if (!isObj(raw.skus) || typeof raw.skus.fba !== "string") missing.push("skus.fba");
  const eco = raw.economics;
  if (!isObj(eco) || !["priceGross", "breakEvenAcos", "targetAcos", "maxTacos"].every((k) => isNum(eco[k]))) missing.push("economics");
  if (!isObj(raw.bidCaps) || !isNum(raw.bidCaps.real) || !isNum(raw.bidCaps.absolute)) missing.push("bidCaps");
  if (!isNum(raw.minFbaUnits)) missing.push("minFbaUnits");
  if (!isNum(raw.minClicksForBidChange)) missing.push("minClicksForBidChange");
  const campaigns = raw.campaigns;
  for (const kind of LAUNCH_KINDS) {
    const c = isObj(campaigns) ? campaigns[kind] : undefined;
    if (!isObj(c) || !isNum(c.dailyBudget) || !isNum(c.defaultBid)) missing.push(`campaigns.${kind}`);
    else if (c.keywords !== undefined && (!Array.isArray(c.keywords) || !c.keywords.every((k) => isObj(k) && typeof k.text === "string" && isNum(k.bid)))) missing.push(`campaigns.${kind}.keywords`);
  }
  const asin = isObj(campaigns) ? campaigns.Asin : undefined;
  const validTarget = (t: unknown) => isObj(t) && isNum(t.bid) && (typeof t.asin === "string") !== (typeof t.category === "string");
  if (asin !== undefined && (!isObj(asin) || !isNum(asin.dailyBudget) || !isNum(asin.defaultBid) || !Array.isArray(asin.targets) || !asin.targets.every(validTarget))) missing.push("campaigns.Asin");
  if (raw.endDate !== undefined && (typeof raw.endDate !== "string" || !DATE_RE.test(raw.endDate))) missing.push("endDate");
  if (!isObj(raw.negatives) || !Array.isArray(raw.negatives.all) || !Array.isArray(raw.negatives.isolateExactIn)) missing.push("negatives");
  if (missing.length) throw new Error(`Seed inválido, faltan o están mal: ${missing.join(", ")}`);
  return raw as unknown as LaunchSeed;
}

/** Every bid the seed would send to Amazon, with where it comes from. */
const targetLabel = (t: SeedTarget) => (t.asin ? `ASIN ${t.asin}` : `categoría ${t.category}`);

function seedBids(seed: LaunchSeed): Array<{ where: string; bid: number }> {
  const asin = seed.campaigns.Asin;
  const kinds = LAUNCH_KINDS.flatMap((kind) => {
    const c = seed.campaigns[kind];
    const auto = c.autoBids ? Object.entries(c.autoBids).filter(([, b]) => b > 0).map(([k, bid]) => ({ where: `${kind} auto ${k}`, bid })) : [];
    return [{ where: `${kind} puja por defecto`, bid: c.defaultBid }, ...auto, ...(c.keywords ?? []).map((k) => ({ where: `${kind} "${k.text}"`, bid: k.bid }))];
  });
  return asin ? [...kinds, { where: `${ASIN_KIND} puja por defecto`, bid: asin.defaultBid }, ...asin.targets.map((t) => ({ where: `${ASIN_KIND} ${targetLabel(t)}`, bid: t.bid }))] : kinds;
}

/** Business rules of the seed; an empty list means it can be applied. */
export function validateLaunchSeed(seed: LaunchSeed): string[] {
  const errors: string[] = [];
  const { economics: eco, bidCaps } = seed;
  if (eco.targetAcos >= eco.breakEvenAcos) errors.push(`ACoS objetivo ${eco.targetAcos} % no está por debajo del equilibrio ${eco.breakEvenAcos} %`);
  if (eco.maxTacos <= 0 || eco.maxTacos >= eco.breakEvenAcos) errors.push(`TACoS máximo ${eco.maxTacos} % fuera de rango`);
  if (bidCaps.absolute > ABSOLUTE_MAX_BID) errors.push(`techo absoluto ${bidCaps.absolute} € supera ${ABSOLUTE_MAX_BID} €`);
  if (bidCaps.real > bidCaps.absolute) errors.push(`techo real ${bidCaps.real} € supera el absoluto ${bidCaps.absolute} €`);
  const cap = Math.min(bidCaps.real, bidCaps.absolute, ABSOLUTE_MAX_BID);
  for (const { where, bid } of seedBids(seed)) {
    if (bid > cap) errors.push(`${where}: puja ${bid} € supera el techo ${cap} €`);
    if (bid < MIN_BID) errors.push(`${where}: puja ${bid} € por debajo del mínimo ${MIN_BID} €`);
  }
  for (const kind of LAUNCH_KINDS) {
    const c = seed.campaigns[kind];
    if (c.dailyBudget < 1) errors.push(`${kind}: presupuesto ${c.dailyBudget} € < 1 €`);
    const texts = (c.keywords ?? []).map((k) => `${norm(k.text)}|${k.matchType ?? ""}`);
    if (new Set(texts).size !== texts.length) errors.push(`${kind}: keywords repetidas`);
  }
  const asin = seed.campaigns.Asin;
  if (asin) {
    if (asin.dailyBudget < 1) errors.push(`${ASIN_KIND}: presupuesto ${asin.dailyBudget} € < 1 €`);
    if (!asin.targets.length) errors.push(`${ASIN_KIND}: sin ASINs ni categorías`);
    const keys = asin.targets.map(targetLabel);
    if (new Set(keys).size !== keys.length) errors.push(`${ASIN_KIND}: segmentaciones repetidas`);
    if (asin.targets.some((t) => t.asin?.toUpperCase() === seed.asin.toUpperCase())) errors.push(`${ASIN_KIND}: no puede segmentar su propio ASIN ${seed.asin}`);
  }
  if (!seed.campaigns.Auto.autoBids) errors.push("Auto: faltan autoBids");
  for (const kind of ["Exact", "Phrase", "Marca"] as const) if (!seed.campaigns[kind].keywords?.length) errors.push(`${kind}: sin keywords`);
  const negatives = new Set(seed.negatives.all.map(norm));
  for (const kind of LAUNCH_KINDS) {
    for (const k of seed.campaigns[kind].keywords ?? []) if (negatives.has(norm(k.text))) errors.push(`${kind}: "${k.text}" es a la vez keyword y negativa`);
  }
  return errors;
}

/** Under the "PF |" prefix so the daily PF agent (guard, regulator, decisions, optimizer) controls them. */
export const launchCampaignName = (country: string, family: string, kind: LaunchKind | typeof ASIN_KIND) => `PF | ${country} | SP-${family} | ${kind}`;

/** Exact and Phrase take the match type of their campaign; Marca keeps each keyword's own (EXACT by default). */
const matchTypeOf = (kind: LaunchKind, k: SeedKeyword): "EXACT" | "PHRASE" => (kind === "Phrase" ? "PHRASE" : kind === "Exact" ? "EXACT" : (k.matchType ?? "EXACT"));

/** Product-targeting campaign of the seed's `campaigns.Asin`: competitor ASINs and categories, no keyword negatives. */
function asinCampaign(seed: LaunchSeed, skus: string[]): PlannedCampaign[] {
  const c = seed.campaigns.Asin;
  if (!c) return [];
  return [
    {
      name: launchCampaignName(seed.country, seed.family, ASIN_KIND),
      targetingType: "MANUAL",
      dailyBudget: c.dailyBudget,
      negativeKeywords: [],
      negativeAsins: [],
      adGroups: [
        {
          name: `${seed.family} ${ASIN_KIND}`,
          defaultBid: c.defaultBid,
          skus,
          keywords: [],
          targets: c.targets.map((t) => (t.asin ? { asin: t.asin, bid: t.bid } : { asin: t.category as string, bid: t.bid, type: "ASIN_CATEGORY_SAME_AS" as const })),
        },
      ],
    },
  ];
}

/** The four launch campaigns (plus the optional ASIN one), one ad group each with every SKU of the family. Never pauses other campaigns. */
export function buildLaunchPlan(seed: LaunchSeed): CampaignPlan {
  const skus = [seed.skus.fba, ...(seed.skus.fbm ? [seed.skus.fbm] : [])];
  const exactTerms = (seed.campaigns.Exact.keywords ?? []).map((k) => k.text);
  const keywordCampaigns: PlannedCampaign[] = LAUNCH_KINDS.map((kind) => {
    const c = seed.campaigns[kind];
    const isolate = seed.negatives.isolateExactIn.includes(kind) ? exactTerms : [];
    return {
      name: launchCampaignName(seed.country, seed.family, kind),
      targetingType: kind === "Auto" ? "AUTO" : "MANUAL",
      dailyBudget: c.dailyBudget,
      negativeKeywords: [...new Map([...seed.negatives.all, ...isolate].map((t) => [norm(t), t])).values()],
      negativeAsins: [],
      adGroups: [
        {
          name: `${seed.family} ${kind}`,
          defaultBid: c.defaultBid,
          skus,
          keywords: (c.keywords ?? []).map((k) => ({ text: k.text, matchType: matchTypeOf(kind, k), bid: k.bid })),
          targets: [],
          ...(kind === "Auto" && c.autoBids ? { autoBids: c.autoBids } : {}),
        },
      ],
    };
  });
  const campaigns = [...keywordCampaigns, ...asinCampaign(seed, skus)].map((c) => (seed.endDate ? { ...c, endDate: seed.endDate } : c));
  const dailyBudget = Math.round(campaigns.reduce((a, c) => a + c.dailyBudget, 0) * 100) / 100;
  return {
    country: seed.country,
    dailyBudget,
    campaigns,
    excluded: [],
    pauseOld: [],
    assumptions: [
      `Lanzamiento ${seed.family} (${seed.asin}) · ACoS equilibrio ${seed.economics.breakEvenAcos} %, objetivo ${seed.economics.targetAcos} %, TACoS < ${seed.economics.maxTacos} %`,
      `Pujas ≤ ${Math.min(seed.bidCaps.real, ABSOLUTE_MAX_BID)} € (techo absoluto ${Math.min(seed.bidCaps.absolute, ABSOLUTE_MAX_BID)} €)`,
      `FBA se activa solo con vendibles + inbound ≥ ${seed.minFbaUnits} u; pujas existentes no se tocan con < ${seed.minClicksForBidChange} clics`,
      ...(seed.endDate ? [`Campañas con fecha de fin ${seed.endDate}`] : []),
    ],
  };
}

/** CPC that keeps a keyword at the target ACoS for an assumed conversion rate (ACoS is measured on gross sales). */
export const targetCpc = (seed: LaunchSeed, cvr: number) => Math.round(seed.economics.priceGross * cvr * (seed.economics.targetAcos / 100) * 100) / 100;

export interface FbaUnits {
  fulfillable: number;
  inbound: number;
}

export function fbaReady(units: FbaUnits | null, minUnits: number): { ready: boolean; total: number } {
  const total = units ? units.fulfillable + units.inbound : 0;
  return { ready: total >= minUnits, total };
}

/** Highest total daily budget that keeps TACoS under the cap, from the family's average daily sales; null without sales. */
export function tacosBudgetCap(dailySales: number, maxTacos: number): number | null {
  return dailySales > 0 ? Math.round(dailySales * (maxTacos / 100) * 100) / 100 : null;
}
