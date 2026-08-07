-- Protege as tabelas usadas pelo assistente de eventos.
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.event_users enable row level security;
alter table public.competitions enable row level security;
alter table public.categories enable row level security;
alter table public.rings enable row level security;

create policy "members read their organization" on public.organizations for select
using (exists(select 1 from public.user_roles ur where ur.organization_id=id and ur.user_id=auth.uid()));
create policy "users read own profile" on public.profiles for select using (id=auth.uid());
create policy "users read own roles" on public.user_roles for select using (user_id=auth.uid());
create policy "event members read membership" on public.event_users for select
using (user_id=auth.uid() or public.can_manage_event(event_id));
create policy "managers manage event membership" on public.event_users for all
using (public.can_manage_event(event_id)) with check (public.can_manage_event(event_id));
create policy "public reads published competitions" on public.competitions for select
using (exists(select 1 from public.events e where e.id=event_id and (e.published_at is not null or public.can_manage_event(e.id))));
create policy "managers manage competitions" on public.competitions for all
using (public.can_manage_event(event_id)) with check (public.can_manage_event(event_id));
create policy "public reads published categories" on public.categories for select
using (exists(select 1 from public.competitions c join public.events e on e.id=c.event_id where c.id=competition_id and (e.published_at is not null or public.can_manage_event(e.id))));
create policy "managers manage categories" on public.categories for all
using (exists(select 1 from public.competitions c where c.id=competition_id and public.can_manage_event(c.event_id)))
with check (exists(select 1 from public.competitions c where c.id=competition_id and public.can_manage_event(c.event_id)));
create policy "members read rings" on public.rings for select
using (public.can_manage_event(event_id) or exists(select 1 from public.event_users eu where eu.event_id=rings.event_id and eu.user_id=auth.uid()));
create policy "managers manage rings" on public.rings for all
using (public.can_manage_event(event_id)) with check (public.can_manage_event(event_id));
