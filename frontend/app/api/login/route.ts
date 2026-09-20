import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, expectedToken, passwordMatches } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  const token = await expectedToken();
  if (!token) return NextResponse.json({ error: "APP_PASSWORD no configurada" }, { status: 503 });

  if (typeof password !== "string" || !(await passwordMatches(password))) {
    await new Promise((resolve) => setTimeout(resolve, 800)); // slows down brute force
    return NextResponse.json({ error: "Contraseña incorrecta" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
