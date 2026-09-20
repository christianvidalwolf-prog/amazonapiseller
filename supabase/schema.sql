-- Ejecutar una vez en Supabase → SQL Editor.
create table if not exists public.snapshots (
  key         text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

-- RLS activado y SIN políticas: la clave anónima/pública no puede leer nada.
-- Solo la service_role key (que bypassa RLS) escribe (GitHub Action) y lee (Vercel, en servidor).
alter table public.snapshots enable row level security;
