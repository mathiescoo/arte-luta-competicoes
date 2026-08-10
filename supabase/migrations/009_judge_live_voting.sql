drop policy if exists "authorized isolated vote" on public.flag_votes;
create policy "judge votes on assigned live matches" on public.flag_votes for insert
with check (
  judge_id=auth.uid()
  and exists(
    select 1 from public.judge_assignments ja
    join public.matches m on m.id=flag_votes.match_id
    where ja.id=flag_votes.assignment_id
      and ja.judge_id=auth.uid()
      and ja.active
      and ja.ring_id=m.ring_id
      and (ja.category_id is null or ja.category_id=m.category_id)
      and m.status in ('live','awaiting_votes')
  )
);

create or replace function public.judge_live_matches()
returns table (
  match_id uuid, assignment_id uuid, ring_name text, category_name text, phase text,
  blue_registration_id uuid, blue_name text, green_registration_id uuid, green_name text, voted boolean
)
language sql stable security definer set search_path=public as $$
  select m.id, ja.id, r.name, c.name, m.phase,
    m.blue_registration_id, blue.full_name, m.green_registration_id, green.full_name,
    exists(select 1 from public.flag_votes fv where fv.match_id=m.id and fv.judge_id=auth.uid())
  from public.matches m
  join public.rings r on r.id=m.ring_id
  join public.categories c on c.id=m.category_id
  join public.registrations rb on rb.id=m.blue_registration_id
  join public.participants blue on blue.id=rb.participant_id
  join public.registrations rg on rg.id=m.green_registration_id
  join public.participants green on green.id=rg.participant_id
  join lateral (
    select a.id from public.judge_assignments a
    where a.judge_id=auth.uid() and a.active and a.ring_id=m.ring_id
      and (a.category_id is null or a.category_id=m.category_id)
    order by a.starts_at nulls first
    limit 1
  ) ja on true
  where m.status in ('live','awaiting_votes');
$$;
