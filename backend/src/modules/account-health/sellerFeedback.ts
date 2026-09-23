import type { SpApiClient } from "../../spapi/client";
import { createReport, downloadReportDocument, getReport, getReportDocument } from "../../spapi/endpoints/reports";
import { sleep } from "../../spapi/rateLimiter";

const FEEDBACK_REPORT_TYPE = "GET_SELLER_FEEDBACK_DATA";
const LOOKBACK_DAYS = 365;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_MAX_RATING = 2; // Amazon counts 1-2 stars as negative

export interface SellerFeedbackItem {
  orderId: string;
  asin: string;
  marketplaceId: string;
  marketplaceCode: string;
  feedbackDate: string; // YYYY-MM-DD
  feedbackType: "NEGATIVE_FEEDBACK";
  defectCount: number;
  rating: number;
  title: string;
  description: string;
  sellerResponse?: string;
}

interface MarketplaceRef {
  code: string;
  id: string;
}

const cache = new Map<string, { at: number; items: SellerFeedbackItem[] }>();

/** "19/9/26" or "19/09/2026" (seller locale, day first) -> "2026-09-19". */
function parseFeedbackDate(raw: string): string {
  const m = raw.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (!m) return raw.trim();
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${year}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/**
 * Columns are positional because the header language follows the seller account:
 * date, rating, comment, seller response, order id, buyer email (deliberately dropped).
 */
function parseFeedbackReport(text: string, marketplace: MarketplaceRef): SellerFeedbackItem[] {
  const items: SellerFeedbackItem[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const rating = Number.parseInt(cols[1] ?? "", 10);
    if (!Number.isFinite(rating) || rating > NEGATIVE_MAX_RATING) continue;
    items.push({
      orderId: (cols[4] ?? "").trim(),
      asin: "",
      marketplaceId: marketplace.id,
      marketplaceCode: marketplace.code,
      feedbackDate: parseFeedbackDate(cols[0] ?? ""),
      feedbackType: "NEGATIVE_FEEDBACK",
      defectCount: 1,
      rating,
      title: `Valoración de ${rating} ${rating === 1 ? "estrella" : "estrellas"}`,
      description: (cols[2] ?? "").trim(),
      sellerResponse: (cols[3] ?? "").trim() || undefined,
    });
  }
  return items;
}

async function fetchOne(client: SpApiClient, marketplace: MarketplaceRef, force: boolean): Promise<SellerFeedbackItem[]> {
  const cached = cache.get(marketplace.code);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.items;

  const end = new Date();
  const start = new Date(end.getTime() - LOOKBACK_DAYS * 24 * 3600 * 1000);
  const { reportId } = await createReport(client, {
    reportType: FEEDBACK_REPORT_TYPE,
    marketplaceIds: [marketplace.id],
    dataStartTime: start.toISOString(),
    dataEndTime: end.toISOString(),
  });

  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(3000);
    const status = await getReport(client, reportId);
    if (status.processingStatus === "DONE") {
      const items = status.reportDocumentId
        ? parseFeedbackReport(
            (await downloadReportDocument(await getReportDocument(client, status.reportDocumentId))).toString("utf-8"),
            marketplace
          )
        : [];
      cache.set(marketplace.code, { at: Date.now(), items });
      return items;
    }
    // Amazon cancels the report when the marketplace has no feedback in the window: that's "none", not a failure.
    if (status.processingStatus === "CANCELLED") {
      cache.set(marketplace.code, { at: Date.now(), items: [] });
      return [];
    }
    if (status.processingStatus === "FATAL") {
      throw new Error(`Informe de feedback ${marketplace.code} terminó con estado FATAL`);
    }
  }
  throw new Error(`Tiempo de espera agotado en el informe de feedback ${marketplace.code}`);
}

/**
 * Negative seller feedback (1-2 stars, with the customer's comment) for the last year.
 * A marketplace that fails (not registered, throttled) is skipped so one bad market
 * doesn't blank the rest; it only throws if every requested marketplace fails.
 */
export async function fetchNegativeFeedback(
  client: SpApiClient,
  marketplaces: MarketplaceRef[],
  force = false,
  /** Stop waiting after this long and return what's ready; unfinished marketplaces keep loading into the cache in the background. */
  budgetMs?: number
): Promise<SellerFeedbackItem[]> {
  const deadline = budgetMs ? Date.now() + budgetMs : Infinity;
  const all: SellerFeedbackItem[] = [];
  let failures = 0;
  let attempted = 0;
  let firstError: unknown;

  // Sequential: Amazon queues concurrent reports of the same type per seller, and createReport for this type is ~1/min.
  for (let i = 0; i < marketplaces.length; i++) {
    const m = marketplaces[i];
    if (Date.now() >= deadline) {
      const rest = marketplaces.slice(i);
      void (async () => {
        for (const r of rest) await fetchOne(client, r, force).catch(() => undefined);
      })();
      break;
    }
    attempted += 1;
    try {
      all.push(...(await fetchOne(client, m, force)));
    } catch (err) {
      failures += 1;
      firstError ??= err;
      console.warn(`Feedback ${m.code}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (attempted > 0 && failures === attempted) {
    throw firstError instanceof Error ? firstError : new Error("No se pudo obtener el feedback");
  }
  return all.sort((a, b) => b.feedbackDate.localeCompare(a.feedbackDate));
}
