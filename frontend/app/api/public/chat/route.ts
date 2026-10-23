import Anthropic from "@anthropic-ai/sdk";
import { type NextRequest, NextResponse } from "next/server";
import { type ChatTurn, chat } from "@/lib/chatbot/agent";
import { isRateLimited } from "@/lib/chatbot/rateLimit";
import { STORE_CONTACT } from "@/lib/chatbot/storeInfo";

// Public endpoint (excluded from the APP_PASSWORD middleware): the chat widget of www.vidalregals.com.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_TURNS = 20;
const MAX_CHARS = 1000;
const DEFAULT_ORIGINS = "https://www.vidalregals.com,https://vidalregals.com";
const FALLBACK_TEXT =
  `Ahora mismo no puedo responder. Puedes escribir a ${STORE_CONTACT.email} o llamar al ` +
  `${STORE_CONTACT.phone} (${STORE_CONTACT.hours}).`;

function allowedOrigins(): Set<string> {
  const list = (process.env.CHATBOT_ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(",").map((o) => o.trim()).filter(Boolean);
  return new Set(list);
}

function isAllowedOrigin(origin: string | null): boolean {
  // Browsers always send Origin on the widget's cross-site POST; a missing one is a script, allowed only in dev.
  if (!origin) return process.env.NODE_ENV !== "production";
  if (process.env.NODE_ENV !== "production" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return allowedOrigins().has(origin);
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && isAllowedOrigin(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

/** Validates the widget payload: alternating text turns, starting and ending with the visitor. */
function parseHistory(body: unknown): ChatTurn[] | null {
  const raw = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const turns: ChatTurn[] = [];
  for (const item of raw.slice(-MAX_TURNS)) {
    const role = (item as { role?: unknown })?.role;
    const text = (item as { text?: unknown })?.text;
    if ((role !== "user" && role !== "assistant") || typeof text !== "string") return null;
    const trimmed = text.trim().slice(0, MAX_CHARS);
    if (!trimmed) continue;
    const last = turns[turns.length - 1];
    if (last?.role === role) turns[turns.length - 1] = { role, text: `${last.text}\n${trimmed}`.slice(0, MAX_CHARS * 2) };
    else turns.push({ role, text: trimmed });
  }
  while (turns[0]?.role === "assistant") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user") return null;
  return turns;
}

export function OPTIONS(req: NextRequest) {
  const origin = req.headers.get("origin");
  return new NextResponse(null, { status: isAllowedOrigin(origin) ? 204 : 403, headers: corsHeaders(origin) });
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);
  if (!isAllowedOrigin(origin)) return NextResponse.json({ error: "origin not allowed" }, { status: 403, headers });
  if (isRateLimited(clientIp(req))) {
    return NextResponse.json(
      { segments: [{ type: "text", text: "Has enviado muchos mensajes seguidos. Espera unos minutos y vuelve a intentarlo." }] },
      { status: 429, headers },
    );
  }

  const history = parseHistory(await req.json().catch(() => null));
  if (!history) return NextResponse.json({ error: "invalid messages" }, { status: 400, headers });

  try {
    const reply = await chat(history);
    const segments = reply.segments.length ? reply.segments : [{ type: "text" as const, text: FALLBACK_TEXT }];
    return NextResponse.json({ segments }, { headers });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) console.error("[chatbot] Anthropic rate limit:", error.message);
    else if (error instanceof Anthropic.APIError) console.error(`[chatbot] Anthropic API error ${error.status}:`, error.message);
    else console.error("[chatbot] chat failed:", error);
    return NextResponse.json({ segments: [{ type: "text", text: FALLBACK_TEXT }] }, { status: 503, headers });
  }
}
