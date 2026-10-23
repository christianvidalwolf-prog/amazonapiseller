import Anthropic from "@anthropic-ai/sdk";
import { type CatalogProduct, getProductsByIds, searchProducts } from "./catalog";
import { SYSTEM_PROMPT } from "./storeInfo";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ProductCard {
  id: number;
  name: string;
  price: number;
  inStock: boolean;
  url: string;
  image: string;
}

export type ReplySegment = { type: "text"; text: string } | { type: "product"; product: ProductCard };

export interface ChatReply {
  segments: ReplySegment[];
}

const MODEL = process.env.CHATBOT_MODEL ?? "claude-haiku-5-5";
const MAX_TOOL_ROUNDS = 4;
// Vercel cuts the function at maxDuration (30 s); stay under it so the route can still answer with CORS headers.
const DEADLINE_MS = 25_000;
const MAX_PRODUCTS_PER_REPLY = 4;
const PRODUCT_MARKER = /\{\{\s*producto\s*:\s*(\d+)\s*\}\}/gi;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_products",
    description:
      "Busca productos activos en el catálogo de Vidal Regals por palabras clave (en español). " +
      "Devuelve hasta 10 productos con id, nombre, precio con IVA en euros, stock, categoría y una descripción corta. " +
      "Úsala siempre antes de recomendar o mencionar un producto.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Palabras clave en español, p. ej. 'figura buda resina' o 'vela aromática'." },
        max_price: { type: "number", description: "Precio máximo en euros con IVA, si el cliente da un presupuesto." },
        min_price: { type: "number", description: "Precio mínimo en euros con IVA." },
        include_out_of_stock: { type: "boolean", description: "Incluir productos sin stock (por defecto no)." },
        limit: { type: "integer", description: "Número de resultados, de 1 a 10 (por defecto 6)." },
      },
      required: ["query"],
    },
  },
];

const client = new Anthropic({ timeout: 20_000, maxRetries: 1 });

function toCard(product: CatalogProduct): ProductCard {
  return {
    id: product.id,
    name: product.name,
    price: product.price,
    inStock: product.stock > 0,
    url: product.url,
    image: product.image,
  };
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function runSearch(input: unknown): Promise<string> {
  const args = (input ?? {}) as Record<string, unknown>;
  const query = typeof args.query === "string" ? args.query.slice(0, 200) : "";
  if (!query.trim()) return JSON.stringify({ error: "query vacía" });
  const results = await searchProducts({
    query,
    minPrice: optionalNumber(args.min_price),
    maxPrice: optionalNumber(args.max_price),
    includeOutOfStock: args.include_out_of_stock === true,
    limit: optionalNumber(args.limit),
  });
  return JSON.stringify({
    total: results.length,
    products: results.map((p) => ({
      id: p.id,
      name: p.name,
      price_eur: p.price,
      in_stock: p.stock > 0,
      category: p.category,
      description: p.description,
    })),
  });
}

async function executeTools(content: Anthropic.ContentBlock[]): Promise<Anthropic.ToolResultBlockParam[]> {
  const calls = content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  return Promise.all(
    calls.map(async (call): Promise<Anthropic.ToolResultBlockParam> => {
      if (call.name !== "search_products") {
        return { type: "tool_result", tool_use_id: call.id, content: `Herramienta desconocida: ${call.name}`, is_error: true };
      }
      try {
        return { type: "tool_result", tool_use_id: call.id, content: await runSearch(call.input) };
      } catch (error) {
        console.error("[chatbot] search_products failed:", error);
        return { type: "tool_result", tool_use_id: call.id, content: "El catálogo no está disponible ahora mismo.", is_error: true };
      }
    }),
  );
}

/** Splits the model's text on {{producto:ID}} markers, keeping only ids that exist in the catalog. */
async function toSegments(text: string): Promise<ReplySegment[]> {
  const ids = [...text.matchAll(PRODUCT_MARKER)].map((m) => Number(m[1]));
  const unique = [...new Set(ids)].slice(0, MAX_PRODUCTS_PER_REPLY);
  let cards = new Map<number, ProductCard>();
  try {
    cards = new Map((await getProductsByIds(unique)).map((p) => [p.id, toCard(p)]));
  } catch (error) {
    // Keep the written answer even if the catalog can't be loaded; markers are dropped below.
    console.error("[chatbot] catalog unavailable while building cards:", error);
  }

  const segments: ReplySegment[] = [];
  const shown = new Set<number>();
  let cursor = 0;
  for (const match of text.matchAll(PRODUCT_MARKER)) {
    const before = text.slice(cursor, match.index).trim();
    if (before) segments.push({ type: "text", text: before });
    const card = cards.get(Number(match[1]));
    if (card && !shown.has(card.id)) {
      segments.push({ type: "product", product: card });
      shown.add(card.id);
    }
    cursor = (match.index ?? 0) + match[0].length;
  }
  const rest = text.slice(cursor).trim();
  if (rest) segments.push({ type: "text", text: rest });
  return segments;
}

function finalText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export async function chat(history: ChatTurn[]): Promise<ChatReply> {
  const messages: Anthropic.MessageParam[] = history.map((turn) => ({ role: turn.role, content: turn.text }));

  const deadline = Date.now() + DEADLINE_MS;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const lastRound = round === MAX_TOOL_ROUNDS;
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 1024,
        output_config: { effort: "low" },
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        // On the last round the model must answer with the results it already has.
        ...(lastRound ? { tool_choice: { type: "none" as const } } : {}),
        messages,
      },
      { signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())) },
    );

    if (response.stop_reason === "refusal") {
      return { segments: [{ type: "text", text: "Lo siento, no puedo ayudarte con eso. ¿Buscas algún producto de la tienda?" }] };
    }
    if (response.stop_reason !== "tool_use" || lastRound) {
      const text = finalText(response.content);
      return { segments: text ? await toSegments(text) : [] };
    }

    // Append the full assistant content (thinking + tool_use blocks) unchanged, then all results in one turn.
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: await executeTools(response.content) });
  }
  return { segments: [] };
}
