import type { RateLimitConfig } from "./types";

/**
 * Classic token-bucket limiter. One bucket per SP-API operation (rateLimitKey),
 * since Amazon grants each operation its own rate/burst — a single global
 * bucket would under-utilize fast endpoints and still throttle slow ones.
 */
class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private readonly rate: number; // tokens per second
  private readonly burst: number; // max bucket size

  constructor(config: RateLimitConfig) {
    this.rate = config.rate;
    this.burst = config.burst;
    this.tokens = config.burst;
    this.lastRefillMs = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillMs) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSeconds * this.rate);
    this.lastRefillMs = now;
  }

  /** Resolves once a token is available, consuming it. */
  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.max(10, Math.ceil((deficit / this.rate) * 1000));
      await sleep(waitMs);
    }
  }
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = { rate: 1, burst: 2 };

export class SpApiRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly defaults: Map<string, RateLimitConfig>;

  constructor(defaults: Record<string, RateLimitConfig> = {}) {
    this.defaults = new Map(Object.entries(defaults));
  }

  async acquire(key: string, override?: RateLimitConfig): Promise<void> {
    const bucket = this.getOrCreateBucket(key, override);
    await bucket.acquire();
  }

  private getOrCreateBucket(key: string, override?: RateLimitConfig): TokenBucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      const config = override ?? this.defaults.get(key) ?? DEFAULT_RATE_LIMIT;
      bucket = new TokenBucket(config);
      this.buckets.set(key, bucket);
    }
    return bucket;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Published SP-API rate limits (requests/sec, burst) for the operations this
 * project calls. Values per Amazon's per-operation documentation; adjust if
 * your application's limits differ (some are negotiated per-seller).
 */
export const SP_API_RATE_LIMITS: Record<string, RateLimitConfig> = {
  "orders.getOrders": { rate: 0.0167, burst: 20 },
  "reports.createReport": { rate: 0.0167, burst: 15 },
  "reports.getReport": { rate: 2, burst: 15 },
  "reports.getReportDocument": { rate: 0.0222, burst: 10 },
  "fbaInventory.getInventorySummaries": { rate: 2, burst: 2 },
  "productPricing.getPricing": { rate: 0.5, burst: 1 },
  "productPricing.getCompetitivePricing": { rate: 0.5, burst: 1 },
  "finances.listFinancialEvents": { rate: 0.5, burst: 30 },
  "sellerPerformance.getReport": { rate: 0.0167, burst: 15 },
  "notifications.createSubscription": { rate: 1, burst: 5 },
  "productTypeDefinitions.getDefinitionsProductType": { rate: 5, burst: 5 },
  "listingsItems.getListingsItem": { rate: 5, burst: 10 },
  "listingsItems.putListingsItem": { rate: 5, burst: 10 },
  "listingsItems.patchListingsItem": { rate: 5, burst: 10 },
  "listingsItems.previewListingsItem": { rate: 5, burst: 10 },
  "feeds.createFeed": { rate: 0.0083, burst: 10 },
  "feeds.createFeedDocument": { rate: 0.0167, burst: 15 },
  "feeds.getFeed": { rate: 2, burst: 15 },
};
