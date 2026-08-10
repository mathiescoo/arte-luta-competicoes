create policy "managers read event votes" on public.flag_votes for select
using (exists(
  select 1 from public.matches m
  join public.categories c on c.id=m.category_id
  join public.competitions cp on cp.id=c.competition_id
  where m.id=flag_votes.match_id and public.can_manage_event(cp.event_id)
));
