import { type NextRequest, NextResponse } from "next/server";
import { type AdsCountry, adsBackendPath, adsCountryFrom, adsSnapshotKey } from "@/lib/adsCountry";
import { isSupabaseConfigured, readSnapshot, writeSnapshot } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

const SNAPSHOT_KEY = "advertising:keywords:harvest";
const backendUrl = () => process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

type Decision = { decision: "approved" | "rejected"; decidedAt: string };
interface Harvest {
  profileId?: string;
  negatives?: { proposals: Array<{ id: string; status: string; decidedAt?: string }> };
}

const decisionsKey = (profileId: string) => `ads:decisions:negatives:${profileId}`;

/** Snapshot published nightly + decisions recorded since then (spec advertising §7). */
async function harvestWithDecisions(country: AdsCountry): Promise<Harvest | null> {
  const row = await readSnapshot(adsSnapshotKey(SNAPSHOT_KEY, country));
  const harvest = row?.data as Harvest | undefined;
  if (!harvest) return null;
  if (!harvest.profileId || !harvest.negatives) return harvest;
  const decisions = ((await readSnapshot(decisionsKey(harvest.profileId)))?.data ?? {}) as Record<string, Decision>;
  return {
    ...harvest,
    negatives: {
      ...harvest.negatives,
      proposals: harvest.negatives.proposals.map((p) => (decisions[p.id] ? { ...p, status: decisions[p.id].decision, decidedAt: decisions[p.id].decidedAt } : p)),
    },
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

/** Body { id, decision: "approved" | "rejected" }: records a human decision on a current proposal. Never touches Amazon. */
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
    const proposal = harvest?.negatives?.proposals.find((p) => p.id === id);
    if (!harvest?.profileId || !proposal) {
      return NextResponse.json({ error: "not_found", message: `No hay ninguna propuesta vigente con id '${id}'` }, { status: 404 });
    }
    const key = decisionsKey(harvest.profileId);
    const decisions = ((await readSnapshot(key))?.data ?? {}) as Record<string, Decision>;
    const record: Decision = { decision, decidedAt: new Date().toISOString() };
    await writeSnapshot(key, { ...decisions, [id]: record });
    return NextResponse.json({ ...proposal, status: decision, decidedAt: record.decidedAt });
  } catch (err) {
    return NextResponse.json({ error: "decision_failed", message: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
