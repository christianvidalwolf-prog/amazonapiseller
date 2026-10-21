import { type NextRequest, NextResponse } from "next/server";
import { type AdsCountry, adsBackendPath, adsCountryFrom, adsSnapshotKey } from "@/lib/adsCountry";
import { isSupabaseConfigured, readSnapshot, writeSnapshot } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

const SNAPSHOT_KEY = "advertising:keywords:harvest";
const REVIEW_AFTER_DAYS = 14;
const backendUrl = () => process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

type Decision = { decision: "approved" | "rejected"; decidedAt: string };
interface Proposal {
  id: string;
  type: string;
  text: string;
  clicks: number;
  spend: number;
  sales?: number;
  acos?: number;
  suggestedBid?: number;
  reason: string;
  status?: string;
  decidedAt?: string;
}
interface Harvest {
  profileId?: string;
  country?: string;
  negatives?: { proposals: Proposal[] };
  harvest?: Proposal[];
}

/** Same keys as the backend (spec advertising §7, §9). */
const decisionsKey = (profileId: string) => `ads:decisions:keywords:${profileId}`;
const changelogKey = (profileId: string) => `ads:changelog:${profileId}`;

const withDecisions = (list: Proposal[] | undefined, decisions: Record<string, Decision>) =>
  list?.map((p) => (decisions[p.id] ? { ...p, status: decisions[p.id].decision, decidedAt: decisions[p.id].decidedAt } : p));

/** Snapshot published nightly + decisions recorded since then. */
async function harvestWithDecisions(country: AdsCountry): Promise<Harvest | null> {
  const row = await readSnapshot(adsSnapshotKey(SNAPSHOT_KEY, country));
  const harvest = row?.data as Harvest | undefined;
  if (!harvest?.profileId) return harvest ?? null;
  const decisions = ((await readSnapshot(decisionsKey(harvest.profileId)))?.data ?? {}) as Record<string, Decision>;
  return {
    ...harvest,
    negatives: harvest.negatives ? { ...harvest.negatives, proposals: withDecisions(harvest.negatives.proposals, decisions) ?? [] } : undefined,
    harvest: withDecisions(harvest.harvest, decisions),
  };
}

export async function GET(request: NextRequest) {
  const country = adsCountryFrom(request.url);
  if (isSupabaseConfigured()) {
    try {
      const harvest = await harvestWithDecisions(country);
      if (harvest) return NextResponse.json(harvest);
    } catch {
      // Fall through to the local backend.
    }
  }
  try {
    const res = await fetch(`${backendUrl()}${adsBackendPath("/api/advertising/keywords/harvest", country)}`, { cache: "no-store" });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "snapshot_not_ready", key: SNAPSHOT_KEY }, { status: 503 });
  }
}

/**
 * Body { id, decision: "approved" | "rejected" }: records a human decision on a current proposal
 * and its Change Log entry (review in 14 days). Never touches Amazon.
 */
export async function PATCH(request: NextRequest) {
  const country = adsCountryFrom(request.url);
  const body = (await request.json().catch(() => null)) as { id?: unknown; decision?: unknown } | null;
  const id = body?.id;
  const decision = body?.decision;
  if (typeof id !== "string" || !id || (decision !== "approved" && decision !== "rejected")) {
    return NextResponse.json({ error: "invalid_body", message: "Se requiere { id: string, decision: 'approved' | 'rejected' }" }, { status: 400 });
  }
  if (!isSupabaseConfigured()) {
    const res = await fetch(`${backendUrl()}${adsBackendPath("/api/advertising/keywords/harvest", country)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision }),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  }
  try {
    const harvest = await harvestWithDecisions(country);
    const proposal = [...(harvest?.negatives?.proposals ?? []), ...(harvest?.harvest ?? [])].find((p) => p.id === id);
    if (!harvest?.profileId || !proposal) {
      return NextResponse.json({ error: "not_found", message: `No hay ninguna propuesta vigente con id '${id}'` }, { status: 404 });
    }
    const date = new Date().toISOString();
    const decisions = ((await readSnapshot(decisionsKey(harvest.profileId)))?.data ?? {}) as Record<string, Decision>;
    await writeSnapshot(decisionsKey(harvest.profileId), { ...decisions, [proposal.id]: { decision, decidedAt: date } });
    const log = ((await readSnapshot(changelogKey(harvest.profileId)))?.data ?? []) as unknown[];
    const entry = {
      entityId: proposal.id,
      date,
      profileId: harvest.profileId,
      country: harvest.country,
      entityType: proposal.type,
      text: proposal.text,
      action: decision,
      oldValue: null,
      newValue: proposal.suggestedBid !== undefined ? `${proposal.type} @ ${proposal.suggestedBid} €` : proposal.type,
      baselineMetric: `${proposal.clicks} clics, ${proposal.spend} € gasto${proposal.sales !== undefined ? `, ${proposal.sales} € ventas, ACoS ${proposal.acos} %` : ", 0 ventas"}`,
      reviewDate: new Date(Date.parse(date) + REVIEW_AFTER_DAYS * 86_400_000).toISOString().slice(0, 10),
      reason: proposal.reason,
    };
    await writeSnapshot(changelogKey(harvest.profileId), [entry, ...log].slice(0, 1000));
    return NextResponse.json({ ...proposal, status: decision, decidedAt: date });
  } catch (err) {
    return NextResponse.json({ error: "decision_failed", message: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
