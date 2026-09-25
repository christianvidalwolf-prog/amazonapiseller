import { type NextRequest, NextResponse } from "next/server";
import { snapshotResponse } from "@/lib/snapshots";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const backendUrl = process.env.NEXT_PUBLIC_API_URL;
  const searchParams = req.nextUrl.searchParams.toString();

  if (backendUrl) {
    try {
      const res = await fetch(`${backendUrl}/api/finance/expenses?${searchParams}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        return NextResponse.json(await res.json());
      }
    } catch {}
  }

  const snapshot = await snapshotResponse("finance:expenses");
  if (!snapshot.ok) {
    return NextResponse.json([]);
  }
  return snapshot;
}

export async function POST(req: NextRequest) {
  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
  try {
    const body = await req.json();
    const res = await fetch(`${backendUrl}/api/finance/expenses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { error: "backend_unavailable", message: "Añadir gastos manuales requiere tener el backend Express en ejecución." },
      { status: 503 }
    );
  }
}
