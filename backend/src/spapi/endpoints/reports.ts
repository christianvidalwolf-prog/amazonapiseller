import type { SpApiClient } from "../client";

export interface CreateReportResponse {
  reportId: string;
}

export interface ReportStatus {
  reportId: string;
  processingStatus: "IN_QUEUE" | "IN_PROGRESS" | "DONE" | "CANCELLED" | "FATAL";
  reportDocumentId?: string;
}

export interface ReportDocument {
  reportDocumentId: string;
  url: string;
  compressionAlgorithm?: "GZIP";
}

/**
 * Requests a report by type (e.g. GET_SALES_AND_TRAFFIC_REPORT,
 * GET_FBA_MYI_ALL_INVENTORY_DATA, GET_V2_SELLER_PERFORMANCE_REPORT).
 * POST /reports/2021-06-30/reports
 */
export async function createReport(
  client: SpApiClient,
  params: { reportType: string; marketplaceIds: string[]; dataStartTime?: string; dataEndTime?: string }
): Promise<CreateReportResponse> {
  return client.request<CreateReportResponse>({
    method: "POST",
    path: "/reports/2021-06-30/reports",
    body: params,
    rateLimitKey: "reports.createReport",
  });
}

/** GET /reports/2021-06-30/reports — list existing reports. */
export async function getReports(
  client: SpApiClient,
  params?: { reportTypes?: string[]; processingStatuses?: string[]; pageSize?: number }
): Promise<{ reports: ReportStatus[]; nextToken?: string }> {
  const searchParams = new URLSearchParams();
  if (params?.reportTypes?.length) searchParams.set("reportTypes", params.reportTypes.join(","));
  if (params?.processingStatuses?.length) searchParams.set("processingStatuses", params.processingStatuses.join(","));
  if (params?.pageSize) searchParams.set("pageSize", String(params.pageSize));

  const query = searchParams.toString();
  return client.request<{ reports: ReportStatus[]; nextToken?: string }>({
    method: "GET",
    path: `/reports/2021-06-30/reports${query ? `?${query}` : ""}`,
    rateLimitKey: "reports.getReports",
  });
}

/** GET /reports/2021-06-30/reports/{reportId} — poll until DONE. */
export async function getReport(client: SpApiClient, reportId: string): Promise<ReportStatus> {
  return client.request<ReportStatus>({
    method: "GET",
    path: `/reports/2021-06-30/reports/${reportId}`,
    rateLimitKey: "reports.getReport",
  });
}

/** GET /reports/2021-06-30/documents/{reportDocumentId} — resolve the download URL. */
export async function getReportDocument(client: SpApiClient, reportDocumentId: string): Promise<ReportDocument> {
  return client.request<ReportDocument>({
    method: "GET",
    path: `/reports/2021-06-30/documents/${reportDocumentId}`,
    rateLimitKey: "reports.getReportDocument",
  });
}

/** Downloads and (if needed) gunzips the report body from its signed URL. */
export async function downloadReportDocument(document: ReportDocument): Promise<Buffer> {
  const response = await fetch(document.url);
  if (!response.ok) throw new Error(`Report document download failed (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (document.compressionAlgorithm === "GZIP") {
    const { gunzipSync } = await import("node:zlib");
    return gunzipSync(buffer);
  }
  return buffer;
}
