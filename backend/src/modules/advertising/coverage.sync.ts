import type { SpApiClient } from "../../spapi/client";
import { createReport, downloadReportDocument, getReport, getReportDocument } from "../../spapi/endpoints/reports";
import { sleep } from "../../spapi/rateLimiter";
import { buildCoverageInput, type CoverageInput } from "./coverage";

const POLL_MS = 20_000;
const MAX_POLLS = 90;

/** Requests one SP-API report and returns its body once DONE (throws on FATAL / CANCELLED / timeout). */
async function fetchReport(client: SpApiClient, params: Parameters<typeof createReport>[1]): Promise<Buffer> {
  const { reportId } = await createReport(client, params);
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_MS);
    const status = await getReport(client, reportId);
    if (status.processingStatus === "DONE" && status.reportDocumentId) return downloadReportDocument(await getReportDocument(client, status.reportDocumentId));
    if (status.processingStatus === "FATAL" || status.processingStatus === "CANCELLED") throw new Error(`${params.reportType} ${status.processingStatus}`);
  }
  throw new Error(`${params.reportType}: Amazon no completó el informe en ${Math.round((POLL_MS * MAX_POLLS) / 60_000)} min`);
}

/** Active listings (SKU ↔ ASIN, FBA or not) of one marketplace from GET_MERCHANT_LISTINGS_ALL_DATA. */
export function parseListings(text: string): Array<{ sku: string; asin: string; fba: boolean }> {
  const [head, ...lines] = text.split(/\r?\n/).filter(Boolean);
  if (!head) return [];
  const cols = head.replace(/^﻿/, "").split("\t");
  const at = (name: string) => cols.indexOf(name);
  const [sku, asin, idType, productId, channel, status] = [at("seller-sku"), at("asin1"), at("product-id-type"), at("product-id"), at("fulfillment-channel"), at("status")];
  // Some marketplaces (FR) omit asin1; product-id is the ASIN when product-id-type is 1.
  const asinOf = (v: string[]) => (asin >= 0 && v[asin] ? v[asin] : idType >= 0 && v[idType] === "1" ? (v[productId] ?? "") : "");
  return lines
    .map((l) => l.split("\t"))
    .filter((v) => (v[status] ?? "").toLowerCase() === "active")
    .map((v) => ({ sku: v[sku] ?? "", asin: asinOf(v), fba: (v[channel] ?? "").toUpperCase().startsWith("AMAZON") }))
    .filter((l) => l.sku && l.asin);
}

/** Coverage input of one marketplace: Sales & Traffic of the 30 days ending 3 days ago + active listings. */
export async function collectCoverageInput(client: SpApiClient, marketplaceId: string, now = new Date()): Promise<CoverageInput> {
  const end = new Date(now.getTime() - 3 * 86_400_000).toISOString().slice(0, 10);
  const start = new Date(now.getTime() - 32 * 86_400_000).toISOString().slice(0, 10);
  const [traffic, listings] = [
    await fetchReport(client, {
      reportType: "GET_SALES_AND_TRAFFIC_REPORT",
      marketplaceIds: [marketplaceId],
      dataStartTime: `${start}T00:00:00Z`,
      dataEndTime: `${end}T23:59:59Z`,
      reportOptions: { dateGranularity: "DAY", asinGranularity: "CHILD" },
    }),
    await fetchReport(client, { reportType: "GET_MERCHANT_LISTINGS_ALL_DATA", marketplaceIds: [marketplaceId] }),
  ];
  const rows = (JSON.parse(traffic.toString("utf8")) as { salesAndTrafficByAsin?: Parameters<typeof buildCoverageInput>[2] }).salesAndTrafficByAsin ?? [];
  return buildCoverageInput(marketplaceId, { start, end }, rows, parseListings(listings.toString("utf8")), now);
}
