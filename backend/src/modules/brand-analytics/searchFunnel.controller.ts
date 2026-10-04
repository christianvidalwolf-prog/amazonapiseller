import type { Request, Response } from "express";
import type { SearchFunnelService } from "./searchFunnel.service";
import { FUNNEL_PERIODS, FUNNEL_STATUSES, type FunnelPeriod, type FunnelStatus } from "./searchFunnel.types";

const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

interface ParsedQuery {
  period: FunnelPeriod;
  asin?: string;
  status?: FunnelStatus;
}

/** Returns the validated filters, or the message of the first invalid one. */
function parseQuery(source: Record<string, unknown>): ParsedQuery | string {
  const text = (value: unknown): string => (typeof value === "string" ? value.trim().toUpperCase() : "");

  const period = text(source.period) || "WEEK";
  if (!FUNNEL_PERIODS.includes(period as FunnelPeriod)) return `period debe ser uno de ${FUNNEL_PERIODS.join(", ")}`;

  const asin = text(source.asin);
  if (asin && !ASIN_PATTERN.test(asin)) return "asin no válido";

  const status = text(source.status);
  if (status && !FUNNEL_STATUSES.includes(status as FunnelStatus)) return `status debe ser uno de ${FUNNEL_STATUSES.join(", ")}`;

  return { period: period as FunnelPeriod, asin: asin || undefined, status: (status || undefined) as FunnelStatus | undefined };
}

export class SearchFunnelController {
  constructor(private readonly service: SearchFunnelService) {}

  /** GET /api/brand-analytics/search-funnel?period=&asin=&status=&refresh= */
  getSearchFunnel = async (req: Request, res: Response): Promise<void> => {
    const query = parseQuery(req.query);
    if (typeof query === "string") {
      res.status(400).json({ error: "invalid_query", message: query });
      return;
    }
    // refresh=true waits for the whole report (minutes): meant for the snapshot publisher, not the UI.
    if (req.query.refresh === "true") {
      const sync = await this.service.sync(query.period);
      if (sync.state === "failed") {
        // Failing here keeps the previously published snapshot instead of replacing it with an empty one.
        res.status(502).json({ error: "sync_failed", message: sync.errors.join(" | ") });
        return;
      }
    }
    res.json(await this.service.getFunnel(query));
  };

  /** POST /api/brand-analytics/search-funnel/sync — starts a sync in the background. */
  startSync = async (req: Request, res: Response): Promise<void> => {
    const query = parseQuery({ ...req.query, ...(req.body as Record<string, unknown> | undefined) });
    if (typeof query === "string") {
      res.status(400).json({ error: "invalid_query", message: query });
      return;
    }
    res.status(202).json(this.service.startSync(query.period, query.asin));
  };

  /** GET /api/brand-analytics/search-funnel/sync */
  getSyncStatus = async (_req: Request, res: Response): Promise<void> => {
    res.json(this.service.getSyncStatus());
  };
}
