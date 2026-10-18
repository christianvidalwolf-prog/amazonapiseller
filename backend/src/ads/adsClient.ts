import { gunzipSync } from "node:zlib";
import { LwaAuthManager } from "../spapi/lwaAuth";
import { sleep as defaultSleep, SpApiRateLimiter } from "../spapi/rateLimiter";
import type { RateLimitConfig, SpApiRegion } from "../spapi/types";
import type { AdCampaign, AdsApiCredentials, AdsErrorKind, AdsProfile } from "./types";

const ADS_REGION_ENDPOINTS: Record<SpApiRegion, string> = {
  EU: "https://advertising-api-eu.amazon.com",
  NA: "https://advertising-api.amazon.com",
  FE: "https://advertising-api-fe.amazon.com",
};

/**
 * Amazon Ads throttles dynamically and does not publish per-operation quotas,
 * so these buckets are deliberately conservative; a 429 still falls back to
 * the Retry-After header Amazon sends.
 */
export const ADS_API_RATE_LIMITS: Record<string, RateLimitConfig> = {
  "ads.getProfiles": { rate: 1, burst: 2 },
  "ads.listSpCampaigns": { rate: 2, burst: 5 },
  "ads.createReport": { rate: 1, burst: 3 },
  "ads.getReport": { rate: 2, burst: 5 },
  /** Campaign-management writes (create/update campaigns, ad groups, ads, keywords, targets, negatives). */
  "ads.write": { rate: 1, burst: 3 },
  "ads.list": { rate: 2, burst: 5 },
};

const SP_CAMPAIGN_MEDIA_TYPE = "application/vnd.spCampaign.v3+json";
const CREATE_REPORT_MEDIA_TYPE = "application/vnd.createasyncreportrequest.v3+json";
const DUPLICATE_REPORT = /duplicate of\s*:?\s*([0-9a-f-]{36})/i;
const SP_CAMPAIGNS_PAGE_SIZE = 100;
const SP_CAMPAIGNS_MAX_PAGES = 50;
const MAX_ERROR_BODY_CHARS = 400;

export class AdsApiError extends Error {
  readonly kind: AdsErrorKind;

  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
    kind?: AdsErrorKind
  ) {
    super(message);
    this.name = "AdsApiError";
    this.kind = kind ?? classifyStatus(statusCode);
  }

  get isRetryable(): boolean {
    return this.kind === "throttled" || this.kind === "server" || this.kind === "network";
  }
}

/** Tells a permissions problem apart from a data problem and from a transport problem. */
export function classifyStatus(status: number): AdsErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "throttled";
  if (status >= 500) return "server";
  if (status === 0) return "network";
  return "client";
}

interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

export interface AdsApiClientOptions {
  maxRetries?: number;
  /** Base delay for exponential backoff, in ms. */
  baseRetryDelayMs?: number;
  /** Test seams: swap the token source, transport and clock. */
  auth?: AccessTokenProvider;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

interface RequestOptions {
  rateLimitKey: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  profileId?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

interface SpCampaignV3 {
  campaignId: string | number;
  name: string;
  state?: string;
  budget?: { budget?: number };
  targetingType?: string;
  startDate?: string;
  endDate?: string;
}

/**
 * HTTP client for the Amazon Ads API: LWA auth, per-operation rate limiting and
 * retries on 429/5xx/network errors (honoring Retry-After). Every failure
 * surfaces as a classified AdsApiError — nothing is swallowed here.
 */
export class AdsApiClient {
  private readonly auth: AccessTokenProvider;
  private readonly rateLimiter = new SpApiRateLimiter(ADS_API_RATE_LIMITS);
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private retryCount = 0;

  constructor(
    private readonly credentials: AdsApiCredentials,
    options: AdsApiClientOptions = {}
  ) {
    this.auth =
      options.auth ??
      new LwaAuthManager({
        lwaClientId: credentials.lwaClientId,
        lwaClientSecret: credentials.lwaClientSecret,
        refreshToken: credentials.refreshToken,
        region: credentials.region,
      });
    this.baseUrl = ADS_REGION_ENDPOINTS[credentials.region];
    this.maxRetries = options.maxRetries ?? 5;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 500;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleepImpl ?? defaultSleep;
  }

  isConfigured(): boolean {
    return Boolean(this.credentials.lwaClientId && this.credentials.lwaClientSecret && this.credentials.refreshToken);
  }

  /** Retries performed since this client was built (observability for the retry policy). */
  get retries(): number {
    return this.retryCount;
  }

  async request<T>(path: string, options: RequestOptions): Promise<T> {
    let attempt = 0;
    for (;;) {
      await this.rateLimiter.acquire(options.rateLimitKey);
      const { error, retryAfter, data } = await this.send<T>(path, options);
      if (!error) return data as T;
      if (!error.isRetryable || attempt >= this.maxRetries) throw error;
      attempt += 1;
      this.retryCount += 1;
      await this.backoff(attempt, retryAfter);
    }
  }

  private async send<T>(
    path: string,
    options: RequestOptions
  ): Promise<{ data?: T; error?: AdsApiError; retryAfter?: string | null }> {
    const accessToken = await this.auth.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Amazon-Advertising-API-ClientId": this.credentials.lwaClientId,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...options.headers,
    };
    if (options.profileId) headers["Amazon-Advertising-API-Scope"] = options.profileId;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: new AdsApiError(0, `Amazon Ads API network error ${path}: ${message}`, undefined, "network") };
    }

    if (response.ok) return { data: (await response.json()) as T };

    const text = await response.text();
    let details: unknown = text;
    try {
      details = JSON.parse(text);
    } catch {
      // Non-JSON error body: keep the raw text as details.
    }
    const error = new AdsApiError(
      response.status,
      `Amazon Ads API request failed [${response.status}] ${path}: ${text.slice(0, MAX_ERROR_BODY_CHARS)}`,
      details
    );
    return { error, retryAfter: response.headers.get("retry-after") };
  }

  /** Exponential backoff with full jitter; Retry-After wins when Amazon sends it. */
  private async backoff(attempt: number, retryAfterHeader?: string | null): Promise<void> {
    const retryAfterMs = Number(retryAfterHeader) * 1000;
    if (retryAfterHeader && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      await this.sleep(retryAfterMs);
      return;
    }
    await this.sleep(Math.random() * this.baseRetryDelayMs * 2 ** attempt);
  }

  /** Campaign-management access for one profile (POST/PUT with Sponsored Products v3 media types). */
  writer(profileId: string) {
    const call = <T>(method: "POST" | "PUT", path: string, mediaType: string, body: unknown) =>
      this.request<T>(path, {
        rateLimitKey: method === "POST" && path.endsWith("/list") ? "ads.list" : "ads.write",
        method,
        profileId,
        body,
        headers: { "Content-Type": mediaType, Accept: mediaType },
      });
    return {
      post: <T>(path: string, mediaType: string, body: unknown) => call<T>("POST", path, mediaType, body),
      put: <T>(path: string, mediaType: string, body: unknown) => call<T>("PUT", path, mediaType, body),
    };
  }

  /** Every advertising profile the authorized user can reach in this region. */
  async getProfiles(): Promise<AdsProfile[]> {
    return this.request<AdsProfile[]>("/v2/profiles", { rateLimitKey: "ads.getProfiles" });
  }

  /** All Sponsored Products campaigns of a profile (v3, follows nextToken). Metrics come from reports, not from here. */
  async listSponsoredProductsCampaigns(profileId: string): Promise<AdCampaign[]> {
    const campaigns: AdCampaign[] = [];
    let nextToken: string | undefined;
    for (let page = 0; page < SP_CAMPAIGNS_MAX_PAGES; page++) {
      const data = await this.request<{ campaigns?: SpCampaignV3[]; nextToken?: string }>("/sp/campaigns/list", {
        rateLimitKey: "ads.listSpCampaigns",
        method: "POST",
        profileId,
        body: { maxResults: SP_CAMPAIGNS_PAGE_SIZE, ...(nextToken ? { nextToken } : {}) },
        headers: { Accept: SP_CAMPAIGN_MEDIA_TYPE, "Content-Type": SP_CAMPAIGN_MEDIA_TYPE },
      });
      campaigns.push(...(data.campaigns ?? []).map(toAdCampaign));
      nextToken = data.nextToken;
      if (!nextToken) return campaigns;
    }
    throw new AdsApiError(0, `SP campaigns list exceeded ${SP_CAMPAIGNS_MAX_PAGES} pages`, undefined, "client");
  }

  /** Starts an async Reporting v3 report; an identical pending request returns the existing report id. */
  async createReport(profileId: string, request: AdsReportRequest): Promise<string> {
    try {
      const data = await this.request<{ reportId: string }>("/reporting/reports", {
        rateLimitKey: "ads.createReport",
        method: "POST",
        profileId,
        body: request,
        headers: { "Content-Type": CREATE_REPORT_MEDIA_TYPE },
      });
      return data.reportId;
    } catch (err) {
      const duplicate = err instanceof AdsApiError && err.statusCode === 425 ? DUPLICATE_REPORT.exec(err.message) : null;
      if (duplicate) return duplicate[1];
      throw err;
    }
  }

  async getReport(profileId: string, reportId: string): Promise<AdsReportStatus> {
    return this.request<AdsReportStatus>(`/reporting/reports/${encodeURIComponent(reportId)}`, {
      rateLimitKey: "ads.getReport",
      profileId,
    });
  }

  /** Downloads a completed report (pre-signed URL, no auth headers) and returns its rows. */
  async downloadReport<T>(url: string): Promise<T[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
    } catch (err) {
      throw new AdsApiError(0, `Ads report download failed: ${err instanceof Error ? err.message : String(err)}`, undefined, "network");
    }
    if (!response.ok) {
      throw new AdsApiError(response.status, `Ads report download failed [${response.status}]`);
    }
    const body = Buffer.from(await response.arrayBuffer());
    const text = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body).toString("utf8") : body.toString("utf8");
    return JSON.parse(text) as T[];
  }
}

export interface AdsReportStatus {
  reportId: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  url?: string;
  failureReason?: string;
}

/** Shape of a Reporting v3 request; see src/ads/reportTypes.ts for the ones this project uses. */
export interface AdsReportRequest {
  name: string;
  startDate: string;
  endDate: string;
  configuration: {
    adProduct: "SPONSORED_PRODUCTS";
    reportTypeId: string;
    groupBy: string[];
    columns: string[];
    timeUnit: "SUMMARY" | "DAILY";
    format: "GZIP_JSON";
  };
}

function toAdCampaign(c: SpCampaignV3): AdCampaign {
  return {
    campaignId: String(c.campaignId),
    name: c.name,
    campaignType: "sponsoredProducts",
    targetingType: c.targetingType?.toLowerCase() === "auto" ? "auto" : "manual",
    state: normalizeState(c.state),
    dailyBudget: Number(c.budget?.budget ?? 0),
    startDate: c.startDate,
    endDate: c.endDate,
    metrics: null,
  };
}

function normalizeState(state?: string): AdCampaign["state"] {
  const s = state?.toLowerCase();
  return s === "enabled" || s === "paused" || s === "archived" ? s : "paused";
}
