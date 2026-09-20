import type { LwaTokenResponse, SpApiCredentials } from "./types";

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

/**
 * Manages the LWA access token lifecycle for one seller/refresh-token pair:
 * exchanges the (long-lived) refresh token for a short-lived access token
 * and caches it in memory until shortly before it expires.
 */
export class LwaAuthManager {
  private accessToken: string | null = null;
  private expiresAtMs = 0;
  private inFlightRefresh: Promise<string> | null = null;

  constructor(private readonly credentials: SpApiCredentials) {}

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    const safetyMarginMs = 60_000;
    if (this.accessToken && now < this.expiresAtMs - safetyMarginMs) {
      return this.accessToken;
    }

    // Collapse concurrent refreshes into a single in-flight request.
    if (!this.inFlightRefresh) {
      this.inFlightRefresh = this.refresh().finally(() => {
        this.inFlightRefresh = null;
      });
    }
    return this.inFlightRefresh;
  }

  private async refresh(): Promise<string> {
    const response = await fetch(LWA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.credentials.refreshToken,
        client_id: this.credentials.lwaClientId,
        client_secret: this.credentials.lwaClientSecret,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LWA token refresh failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as LwaTokenResponse;
    this.accessToken = data.access_token;
    this.expiresAtMs = Date.now() + data.expires_in * 1000;
    return this.accessToken;
  }
}
