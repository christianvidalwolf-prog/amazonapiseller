/** Countries with an Amazon Ads profile analysed by the panel; ES is the default (unsuffixed) snapshot. */
export const ADS_COUNTRIES = ["ES", "DE", "FR", "IT"] as const;
export type AdsCountry = (typeof ADS_COUNTRIES)[number];

export function adsCountryFrom(url: string): AdsCountry {
  const raw = new URL(url).searchParams.get("country")?.toUpperCase();
  return (ADS_COUNTRIES as readonly string[]).includes(raw ?? "") ? (raw as AdsCountry) : "ES";
}

/** Snapshot key for a country: `advertising:summary` (ES) or `advertising:summary:DE`. */
export const adsSnapshotKey = (base: string, country: AdsCountry) => (country === "ES" ? base : `${base}:${country}`);

export const adsBackendPath = (path: string, country: AdsCountry) => (country === "ES" ? path : `${path}?country=${country}`);
