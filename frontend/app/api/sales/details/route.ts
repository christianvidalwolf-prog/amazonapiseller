import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
  const searchParams = req.nextUrl.searchParams.toString();

  try {
    const res = await fetch(`${backendUrl}/api/sales/details?${searchParams}`, {
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({ error: `Backend error ${res.status}` }, { status: res.status });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      {
        error: "backend_unavailable",
        message: "El desglose detallado de pedidos requiere tener el backend Express en ejecución.",
      },
      { status: 503 }
    );
  }
}
