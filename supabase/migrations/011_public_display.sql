create or replace function public.display_board(session_pin text)
returns table (
  session_name text, event_name text, ring_name text, match_status text, phase text,
  blue_name text, green_name text, blue_votes bigint, green_votes bigint, winner_name text
)
language sql stable security definer set search_path=public as $$
  select ds.name, e.name, r.name, m.status, m.phase,
    blue.full_name, green.full_name,
    coalesce((select count(*) from public.flag_votes fv where fv.match_id=m.id and fv.color='blue'),0),
    coalesce((select count(*) from public.flag_votes fv where fv.match_id=m.id and fv.color='green'),0),
    case when m.winner_registration_id=m.blue_registration_id then blue.full_name when m.winner_registration_id=m.green_registration_id then green.full_name else null end
  from public.display_sessions ds
  join public.events e on e.id=ds.event_id
  left join public.rings r on r.id=ds.ring_id
  left join lateral (
    select mm.* from public.matches mm
    join public.categories c on c.id=mm.category_id
    join public.competitions cp on cp.id=c.competition_id
    where cp.event_id=ds.event_id and (ds.ring_id is null or mm.ring_id=ds.ring_id)
    order by case mm.status when 'live' then 0 when 'finished' then 1 else 2 end, coalesce(mm.finished_at,mm.started_at) desc nulls last
    limit 1
  ) m on true
  left join public.registrations rb on rb.id=m.blue_registration_id
  left join public.participants blue on blue.id=rb.participant_id
  left join public.registrations rg on rg.id=m.green_registration_id
  left join public.participants green on green.id=rg.participant_id
  where ds.pin=session_pin and ds.active;
$$;
