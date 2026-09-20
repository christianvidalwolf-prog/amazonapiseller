export type SpApiRegion = "EU" | "NA" | "FE";

export interface SpApiCredentials {
  lwaClientId: string;
  lwaClientSecret: string;
  refreshToken: string;
  region: SpApiRegion;
}

export interface LwaTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

export interface RateLimitConfig {
  /** Sustained requests per second Amazon grants this operation. */
  rate: number;
  /** Max burst size (bucket capacity). */
  burst: number;
}

export interface SpApiRequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Rate-limit bucket key, e.g. "orders.getOrders" or "listings.putListingsItem". */
  rateLimitKey: string;
  /** Per-operation rate limit; falls back to a conservative default if omitted. */
  rateLimit?: RateLimitConfig;
}

export interface AmazonErrorDetail {
  code: string;
  message: string;
  details?: string;
}

export class SpApiError extends Error {
  readonly statusCode: number;
  readonly errors: AmazonErrorDetail[];
  readonly requestId?: string;

  constructor(statusCode: number, errors: AmazonErrorDetail[], requestId?: string) {
    super(errors.map((e) => `${e.code}: ${e.message}`).join("; ") || `SP-API error (${statusCode})`);
    this.name = "SpApiError";
    this.statusCode = statusCode;
    this.errors = errors;
    this.requestId = requestId;
  }

  get isThrottled(): boolean {
    return this.statusCode === 429;
  }

  get isRetryable(): boolean {
    return this.statusCode === 429 || this.statusCode >= 500;
  }
}
