import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { asin: string } }
) {
  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
  const days = req.nextUrl.searchParams.get("days") || "60";
  const asin = params.asin;

  try {
    const res = await fetch(`${backendUrl}/api/bsr/history/${encodeURIComponent(asin)}?days=${days}`, {
      cache: "no-store",
    });
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
