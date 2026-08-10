alter table public.results enable row level security;

create policy "managers manage results" on public.results for all
using (exists(
  select 1 from public.categories c
  join public.competitions cp on cp.id=c.competition_id
  where c.id=results.category_id and public.can_manage_event(cp.event_id)
))
with check (exists(
  select 1 from public.categories c
  join public.competitions cp on cp.id=c.competition_id
  where c.id=results.category_id and public.can_manage_event(cp.event_id)
));

create unique index if not exists results_category_registration_unique
on public.results(category_id, registration_id);
