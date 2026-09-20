import { LwaAuthManager } from "./lwaAuth";
import { SP_API_RATE_LIMITS, SpApiRateLimiter, sleep } from "./rateLimiter";
import { SpApiError, type SpApiCredentials, type SpApiRegion, type SpApiRequestOptions } from "./types";

const REGION_ENDPOINTS: Record<SpApiRegion, string> = {
  EU: "https://sellingpartnerapi-eu.amazon.com",
  NA: "https://sellingpartnerapi-na.amazon.com",
  FE: "https://sellingpartnerapi-fe.amazon.com",
};

export interface SpApiClientOptions {
  credentials: SpApiCredentials;
  maxRetries?: number;
  /** Base delay for exponential backoff, in ms. */
  baseRetryDelayMs?: number;
}

/**
 * Base HTTP client for Amazon Selling Partner API.
 *
 * Responsibilities:
 *  - LWA authentication (delegated to LwaAuthManager, refreshed transparently)
 *  - Per-operation rate limiting (token bucket, delegated to SpApiRateLimiter)
 *  - Retries with exponential backoff + jitter on 429/5xx
 *
 * All module-specific endpoint wrappers (orders, inventory, pricing, finances,
 * listings, feeds, ...) sit on top of `request()` in src/spapi/endpoints/*.
 */
export class SpApiClient {
  private readonly auth: LwaAuthManager;
  private readonly rateLimiter: SpApiRateLimiter;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;

  constructor(options: SpApiClientOptions) {
    this.auth = new LwaAuthManager(options.credentials);
    this.rateLimiter = new SpApiRateLimiter(SP_API_RATE_LIMITS);
    this.baseUrl = REGION_ENDPOINTS[options.credentials.region];
    this.maxRetries = options.maxRetries ?? 5;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 500;
  }

  async request<T>(options: SpApiRequestOptions): Promise<T> {
    let attempt = 0;

    for (;;) {
      await this.rateLimiter.acquire(options.rateLimitKey, options.rateLimit);

      const accessToken = await this.auth.getAccessToken();
      const url = this.buildUrl(options.path, options.query);

      const response = await fetch(url, {
        method: options.method,
        headers: {
          "x-amz-access-token": accessToken,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }

      const error = await this.parseError(response);

      const canRetry = error.isRetryable && attempt < this.maxRetries;
      if (!canRetry) throw error;

      attempt += 1;
      await this.backoff(attempt, response.headers.get("retry-after"));
    }
  }

  private async parseError(response: Response): Promise<SpApiError> {
    let errors: SpApiError["errors"] = [];
    try {
      const body = (await response.json()) as { errors?: SpApiError["errors"] };
      errors = body.errors ?? [];
    } catch {
      errors = [{ code: "UNKNOWN", message: response.statusText }];
    }
    return new SpApiError(response.status, errors, response.headers.get("x-amzn-requestid") ?? undefined);
  }

  /** Exponential backoff with full jitter; honors Retry-After when Amazon sends it. */
  private async backoff(attempt: number, retryAfterHeader: string | null): Promise<void> {
    if (retryAfterHeader) {
      const retryAfterMs = Number(retryAfterHeader) * 1000;
      if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        await sleep(retryAfterMs);
        return;
      }
    }
    const maxDelay = this.baseRetryDelayMs * 2 ** attempt;
    const delay = Math.random() * maxDelay;
    await sleep(delay);
  }

  private buildUrl(path: string, query?: SpApiRequestOptions["query"]): string {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}
