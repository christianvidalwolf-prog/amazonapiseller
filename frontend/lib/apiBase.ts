// Local dev talks to the Express backend; a production build (Vercel) uses same-origin /api routes backed by Supabase.
export const API_ORIGIN =
  process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === "production" ? "" : "http://localhost:4000");
