import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
  try {
    const res = await fetch(`${backendUrl}/api/bsr/catalog`, { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json({ error: `Backend error ${res.status}` }, { status: res.status });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: "backend_unavailable", message: "Requiere el backend Express en ejecución." },
      { status: 503 }
    );
  }
}
