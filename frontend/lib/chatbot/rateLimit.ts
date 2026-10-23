/**
 * Best-effort per-IP limiter for the public chat. State lives in the serverless instance's memory,
 * so it caps bursts from one visitor, not a distributed attack; the hard cost ceiling is the
 * per-request token cap plus the spend limit configured on the Anthropic API key.
 */
const WINDOW_MS = 10 * 60 * 1000;
const configuredMax = Number(process.env.CHATBOT_MAX_MESSAGES_PER_10MIN);
const MAX_REQUESTS_PER_WINDOW = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 30;
const MAX_TRACKED_IPS = 5000;

const hits = new Map<string, number[]>();

export function isRateLimited(ip: string, now = Date.now()): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    hits.set(ip, recent);
    return true;
  }
  if (!hits.has(ip) && hits.size >= MAX_TRACKED_IPS) {
    const oldest = hits.keys().next().value;
    if (oldest !== undefined) hits.delete(oldest);
  }
  hits.set(ip, [...recent, now]);
  return false;
}
