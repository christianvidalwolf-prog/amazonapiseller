import "dotenv/config";
import type { SpApiCredentials, SpApiRegion } from "../spapi/types";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  spApi: {
    lwaClientId: required("LWA_CLIENT_ID"),
    lwaClientSecret: required("LWA_CLIENT_SECRET"),
    refreshToken: required("SP_API_REFRESH_TOKEN"),
    region: (process.env.SP_API_REGION ?? "EU").toUpperCase() as SpApiRegion,
  } satisfies SpApiCredentials,
  sellerId: required("SP_API_SELLER_ID"),
  marketplaceIds: required("SP_API_MARKETPLACE_IDS").split(",").map((id) => id.trim()),
  adsApi: {
    lwaClientId: process.env.ADS_API_CLIENT_ID || process.env.LWA_CLIENT_ID || "",
    lwaClientSecret: process.env.ADS_API_CLIENT_SECRET || process.env.LWA_CLIENT_SECRET || "",
    refreshToken: process.env.ADS_API_REFRESH_TOKEN || "",
    profileId: process.env.ADS_API_PROFILE_ID || "",
    region: (process.env.ADS_API_REGION ?? process.env.SP_API_REGION ?? "EU").toUpperCase() as SpApiRegion,
  },
};
