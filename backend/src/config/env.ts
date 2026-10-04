import "dotenv/config";
import type { SpApiCredentials, SpApiRegion } from "../spapi/types";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function normalizeUrl(value: string | undefined): string {
  const url = (value ?? "").trim().replace(/\/+$/, "");
  return url && !/^https?:\/\//.test(url) ? `https://${url}` : url;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  redisUrl: process.env.REDIS_URL?.trim() ?? "redis://localhost:6379",
  spApi: {
    lwaClientId: required("LWA_CLIENT_ID"),
    lwaClientSecret: required("LWA_CLIENT_SECRET"),
    refreshToken: required("SP_API_REFRESH_TOKEN"),
    region: (process.env.SP_API_REGION?.trim() ?? "EU").toUpperCase() as SpApiRegion,
  } satisfies SpApiCredentials,
  sellerId: required("SP_API_SELLER_ID"),
  marketplaceIds: required("SP_API_MARKETPLACE_IDS").split(",").map((id) => id.trim()),
  /** Brand Analytics → Search Query Performance (dashboard "Funnels de Búsqueda"). */
  brandAnalytics: {
    asins: (process.env.SQP_ASINS ?? "").split(",").map((asin) => asin.trim().toUpperCase()).filter(Boolean),
    brand: process.env.SQP_BRAND?.trim() ?? "ROCKING GIFTS",
    maxAsins: Number(process.env.SQP_MAX_ASINS) || 36,
    /** Reports one process may request in a burst; refills at Amazon's own rate of one per minute. */
    maxReports: Number(process.env.SQP_MAX_REPORTS) || 12,
    /** Marketplace codes the snapshot publisher covers. */
    marketplaces: (process.env.SQP_MARKETPLACES ?? "ES,DE,FR,IT").split(",").map((code) => code.trim().toUpperCase()).filter(Boolean),
  },
  /** Optional: where the search funnel keeps its report rows. Without it the Prisma database is used. */
  supabase: {
    url: normalizeUrl(process.env.SUPABASE_URL),
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "",
  },
  adsApi: {
    lwaClientId: process.env.ADS_API_CLIENT_ID?.trim() || process.env.LWA_CLIENT_ID?.trim() || "",
    lwaClientSecret: process.env.ADS_API_CLIENT_SECRET?.trim() || process.env.LWA_CLIENT_SECRET?.trim() || "",
    refreshToken: process.env.ADS_API_REFRESH_TOKEN?.trim() || "",
    profileId: process.env.ADS_API_PROFILE_ID?.trim() || "",
    region: (process.env.ADS_API_REGION?.trim() ?? process.env.SP_API_REGION?.trim() ?? "EU").toUpperCase() as SpApiRegion,
  },
};
