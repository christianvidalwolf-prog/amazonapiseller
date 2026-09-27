-- Ejecutar en Supabase → SQL Editor:
create table if not exists public.snapshots (
  key         text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Asegurar que la tabla permita inserciones/actualizaciones tanto con la clave service_role
-- como con la clave anon/authenticated (por si se configuró la clave pública por error en GitHub Secrets o Vercel):
alter table public.snapshots enable row level security;

drop policy if exists "snapshots_allow_all" on public.snapshots;

create policy "snapshots_allow_all" on public.snapshots
  for all
  using (true)
  with check (true);

