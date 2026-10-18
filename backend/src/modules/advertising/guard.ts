/**
 * Daily stock / Buy Box guard of the profit-first campaigns (spec advertising §11).
 * An ad whose product cannot be bought (no stock, or someone else holds the Buy Box) is paused,
 * and re-enabled when it can be bought again. It only re-enables ads it paused itself: ads paused
 * for any other reason (plan exclusions, human decisions) are never touched.
 */

export interface GuardAd {
  adId: string;
  sku: string;
  state: "ENABLED" | "PAUSED" | string;
}

export interface Availability {
  available: boolean;
  reason?: string;
}

export interface GuardState {
  /** Ads paused by the guard, by adId. */
  paused: Record<string, { sku: string; reason: string; date: string }>;
  /** Last regulator run (ISO date). */
  lastRegulatorRun?: string;
}

export interface GuardDecision {
  pause: Array<{ adId: string; sku: string; reason: string }>;
  resume: Array<{ adId: string; sku: string }>;
  next: GuardState;
}

export function guardAds(ads: GuardAd[], availability: Map<string, Availability>, state: GuardState, today: string): GuardDecision {
  const paused = { ...state.paused };
  const pause: GuardDecision["pause"] = [];
  const resume: GuardDecision["resume"] = [];
  for (const ad of ads) {
    const status = availability.get(ad.sku);
    if (!status) continue; // unknown → leave as is
    const enabled = ad.state.toUpperCase() === "ENABLED";
    if (enabled && !status.available) {
      const reason = status.reason ?? "no disponible";
      pause.push({ adId: ad.adId, sku: ad.sku, reason });
      paused[ad.adId] = { sku: ad.sku, reason, date: today };
    } else if (!enabled && status.available && paused[ad.adId]) {
      resume.push({ adId: ad.adId, sku: ad.sku });
      delete paused[ad.adId];
    }
  }
  return { pause, resume, next: { ...state, paused } };
}
