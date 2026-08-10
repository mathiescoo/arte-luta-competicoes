alter table public.matches enable row level security;
create policy "managers manage matches" on public.matches for all
using (exists(select 1 from public.categories c join public.competitions cp on cp.id=c.competition_id where c.id=matches.category_id and public.can_manage_event(cp.event_id)))
with check (exists(select 1 from public.categories c join public.competitions cp on cp.id=c.competition_id where c.id=matches.category_id and public.can_manage_event(cp.event_id)));
