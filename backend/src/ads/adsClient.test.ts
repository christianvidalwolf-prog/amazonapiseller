import { describe, expect, it } from "vitest";
import { AdsApiClient, AdsApiError, classifyStatus } from "./adsClient";

const CREDS = { lwaClientId: "cid", lwaClientSecret: "secret", refreshToken: "rt", region: "EU" as const };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Client wired to a scripted transport; records requests and every backoff wait. */
function scripted(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const waits: number[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no scripted response left");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const client = new AdsApiClient(CREDS, {
    auth: { getAccessToken: async () => "token" },
    fetchImpl,
    sleepImpl: async (ms) => {
      waits.push(ms);
    },
    maxRetries: 2,
  });
  return { client, calls, waits };
}

describe("classifyStatus", () => {
  it("separates permissions, throttling, data and server problems", () => {
    expect(classifyStatus(401)).toBe("auth");
    expect(classifyStatus(403)).toBe("auth");
    expect(classifyStatus(429)).toBe("throttled");
    expect(classifyStatus(400)).toBe("client");
    expect(classifyStatus(503)).toBe("server");
  });
});

describe("AdsApiClient.request", () => {
  it("retries a 429 after the Retry-After Amazon sends", async () => {
    const { client, waits } = scripted([json(429, { code: "THROTTLED" }, { "retry-after": "3" }), json(200, [])]);
    await expect(client.getProfiles()).resolves.toEqual([]);
    expect(waits).toEqual([3000]);
    expect(client.retries).toBe(1);
  });

  it("retries network failures and 5xx, then gives up with a classified error", async () => {
    const { client, calls } = scripted([new Error("ECONNRESET"), json(502, {}), json(503, {})]);
    const err = await client.getProfiles().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdsApiError);
    expect((err as AdsApiError).kind).toBe("server");
    expect(calls).toHaveLength(3);
  });

  it("never retries an authorization failure", async () => {
    const { client, calls } = scripted([json(401, { code: "UNAUTHORIZED" })]);
    const err = (await client.getProfiles().catch((e: unknown) => e)) as AdsApiError;
    expect(err.kind).toBe("auth");
    expect(err.statusCode).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it("sends client id and profile scope headers", async () => {
    const { client, calls } = scripted([json(200, { campaigns: [] })]);
    await client.listSponsoredProductsCampaigns("123");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Amazon-Advertising-API-ClientId"]).toBe("cid");
    expect(headers["Amazon-Advertising-API-Scope"]).toBe("123");
    expect(headers.Authorization).toBe("Bearer token");
  });
});

describe("AdsApiClient.listSponsoredProductsCampaigns", () => {
  it("follows nextToken and leaves metrics null instead of zero-filling", async () => {
    const { client, calls } = scripted([
      json(200, { campaigns: [{ campaignId: 1, name: "A", state: "ENABLED", budget: { budget: 5 }, targetingType: "AUTO" }], nextToken: "p2" }),
      json(200, { campaigns: [{ campaignId: 2, name: "B", state: "PAUSED", targetingType: "MANUAL" }] }),
    ]);
    const campaigns = await client.listSponsoredProductsCampaigns("123");
    expect(campaigns.map((c) => [c.campaignId, c.state, c.targetingType, c.dailyBudget])).toEqual([
      ["1", "enabled", "auto", 5],
      ["2", "paused", "manual", 0],
    ]);
    expect(campaigns.every((c) => c.metrics === null)).toBe(true);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ maxResults: 100, nextToken: "p2" });
  });
});
