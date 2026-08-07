create table if not exists public.display_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  event_id uuid not null references public.events on delete cascade,
  ring_id uuid references public.rings on delete set null,
  name text not null,
  pin text not null check (pin ~ '^[0-9]{6}$'),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists display_sessions_event_name_idx on public.display_sessions(event_id,name);
alter table public.display_sessions enable row level security;
create policy "managers manage display sessions" on public.display_sessions for all
using (public.can_manage_event(event_id)) with check (public.can_manage_event(event_id));
