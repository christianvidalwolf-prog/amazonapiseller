import { readSnapshot } from "@/lib/snapshots";

/** One product of the public catalog (built by prestashop/build_chat_catalog.py). */
export interface CatalogProduct {
  id: number;
  name: string;
  ref: string;
  price: number;
  stock: number;
  category: string;
  url: string;
  image: string;
  description: string;
}

interface Catalog {
  updatedAt: string;
  products: CatalogProduct[];
}

interface IndexedProduct {
  product: CatalogProduct;
  name: string;
  category: string;
  description: string;
}

interface LoadedCatalog {
  byId: Map<number, CatalogProduct>;
  indexed: IndexedProduct[];
  loadedAt: number;
}

export interface SearchOptions {
  query: string;
  minPrice?: number;
  maxPrice?: number;
  includeOutOfStock?: boolean;
  limit?: number;
}

const SNAPSHOT_KEY = "chatbot:catalog";
const CACHE_MS = 15 * 60 * 1000;
const MAX_RESULTS = 10;
const STOPWORDS = new Set([
  "de", "del", "la", "las", "el", "los", "un", "una", "unos", "unas", "y", "o", "para", "con", "sin",
  "en", "por", "que", "mas", "muy", "algo", "busco", "quiero", "tienes", "teneis", "hay", "regalo",
]);

let cache: LoadedCatalog | null = null;
let inflight: Promise<LoadedCatalog> | null = null;

export function normalize(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ]+/g, " ").trim();
}

/** Crude Spanish plural/gender folding: "velas"→"vela", "relojes"→"reloj", "decorativos"/"decorativa"→"decorativ". */
function stem(token: string): string {
  let word = token;
  if (word.length > 4 && word.endsWith("es")) word = word.slice(0, -2);
  else if (word.length > 3 && word.endsWith("s")) word = word.slice(0, -1);
  if (word.length > 5 && (word.endsWith("o") || word.endsWith("a"))) word = word.slice(0, -1);
  return word;
}

function tokenize(text: string): string[] {
  return normalize(text)
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

async function loadCatalog(): Promise<LoadedCatalog> {
  const row = await readSnapshot(SNAPSHOT_KEY);
  const catalog = row?.data as Catalog | undefined;
  if (!catalog?.products?.length) throw new Error("Catálogo del chatbot vacío o no publicado");
  const indexed = catalog.products.map((product) => ({
    product,
    name: ` ${tokenize(product.name).join(" ")} `,
    category: ` ${tokenize(product.category).join(" ")} `,
    description: ` ${tokenize(`${product.description} ${product.ref}`).join(" ")} `,
  }));
  return { byId: new Map(catalog.products.map((p) => [p.id, p])), indexed, loadedAt: Date.now() };
}

export async function getCatalog(): Promise<LoadedCatalog> {
  if (cache && Date.now() - cache.loadedAt < CACHE_MS) return cache;
  if (!inflight) {
    inflight = loadCatalog()
      .then((loaded) => {
        cache = loaded;
        return loaded;
      })
      .finally(() => {
        inflight = null;
      });
  }
  try {
    return await inflight;
  } catch (error) {
    // A stale catalog beats no answers while Supabase hiccups.
    if (cache) return cache;
    throw error;
  }
}

function score(entry: IndexedProduct, tokens: string[]): number {
  let total = 0;
  let matched = 0;
  for (const token of tokens) {
    const word = ` ${token} `;
    let points = 0;
    if (entry.name.includes(word)) points = 4;
    else if (entry.name.includes(` ${token}`)) points = 2.5;
    if (entry.category.includes(` ${token}`)) points = Math.max(points, 2);
    if (!points && entry.description.includes(` ${token}`)) points = 1;
    if (points) matched += 1;
    total += points;
  }
  if (!matched) return 0;
  // Products matching every term rank above products matching one term many times.
  return total * (matched / tokens.length) ** 2 + (entry.product.stock > 0 ? 0.5 : 0);
}

export async function searchProducts(options: SearchOptions): Promise<CatalogProduct[]> {
  const { indexed } = await getCatalog();
  const tokens = tokenize(options.query);
  if (!tokens.length) return [];
  const limit = Math.min(Math.max(options.limit ?? 6, 1), MAX_RESULTS);

  return indexed
    .filter(({ product }) => options.includeOutOfStock || product.stock > 0)
    .filter(({ product }) => options.minPrice === undefined || product.price >= options.minPrice)
    .filter(({ product }) => options.maxPrice === undefined || product.price <= options.maxPrice)
    .map((entry) => ({ entry, points: score(entry, tokens) }))
    .filter(({ points }) => points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, limit)
    .map(({ entry }) => entry.product);
}

export async function getProductsByIds(ids: number[]): Promise<CatalogProduct[]> {
  const { byId } = await getCatalog();
  return ids.map((id) => byId.get(id)).filter((p): p is CatalogProduct => Boolean(p));
}
