-- Integridade do julgamento por bandeiras.
-- Execute depois das migrations 001 a 016 no SQL Editor do Supabase.

-- Um confronto só pode ser finalizado pela função abaixo, depois de todos os
-- juízes ativos da combinação evento + competição + roda + categoria votarem.
create or replace function public.prevent_unverified_match_finalization()
returns trigger
language plpgsql
as $$
begin
  if (new.status = 'finished' or old.status = 'finished')
    and coalesce(current_setting('app.allow_match_finalize', true), '') <> 'true' then
    raise exception 'matches must be finalized through finalize_match';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_match_finalization on public.matches;
create trigger protect_match_finalization
before update on public.matches
for each row execute function public.prevent_unverified_match_finalization();

-- Impede a atualização direta de um confronto para finalizado e valida que
-- roda e inscrições pertencem à mesma categoria/evento.
drop policy if exists "managers manage matches" on public.matches;
drop policy if exists "managers read matches" on public.matches;
drop policy if exists "managers create matches" on public.matches;
drop policy if exists "managers update active matches" on public.matches;
drop policy if exists "managers delete matches" on public.matches;

create policy "managers read matches" on public.matches for select
using (
  exists (
    select 1
    from public.categories c
    join public.competitions cp on cp.id = c.competition_id
    where c.id = matches.category_id
      and cp.model = 'digital_flags'
      and public.can_manage_event(cp.event_id)
  )
);

create policy "managers create matches" on public.matches for insert
with check (
  exists (
    select 1
    from public.categories c
    join public.competitions cp on cp.id = c.competition_id
    join public.rings r on r.id = matches.ring_id and r.event_id = cp.event_id
    join public.registrations blue on blue.id = matches.blue_registration_id
      and blue.event_id = cp.event_id and blue.category_id = c.id
    join public.registrations green on green.id = matches.green_registration_id
      and green.event_id = cp.event_id and green.category_id = c.id
    where c.id = matches.category_id
      and cp.model = 'digital_flags'
      and blue.id <> green.id
      and public.can_manage_event(cp.event_id)
  )
);

create policy "managers update active matches" on public.matches for update
using (
  exists (
    select 1
    from public.categories c
    join public.competitions cp on cp.id = c.competition_id
    where c.id = matches.category_id
      and cp.model = 'digital_flags'
      and public.can_manage_event(cp.event_id)
  )
)
with check (
  matches.status <> 'finished'
  and exists (
    select 1
    from public.categories c
    join public.competitions cp on cp.id = c.competition_id
    join public.rings r on r.id = matches.ring_id and r.event_id = cp.event_id
    join public.registrations blue on blue.id = matches.blue_registration_id
      and blue.event_id = cp.event_id and blue.category_id = c.id
    join public.registrations green on green.id = matches.green_registration_id
      and green.event_id = cp.event_id and green.category_id = c.id
    where c.id = matches.category_id
      and cp.model = 'digital_flags'
      and blue.id <> green.id
      and public.can_manage_event(cp.event_id)
  )
);

create policy "managers delete matches" on public.matches for delete
using (
  exists (
    select 1
    from public.categories c
    join public.competitions cp on cp.id = c.competition_id
    where c.id = matches.category_id
      and public.can_manage_event(cp.event_id)
  )
);

-- O voto só é aceito se for de um juiz ativo, na competição correta, na roda
-- correta e para o competidor que corresponde à cor escolhida.
drop policy if exists "authorized isolated vote" on public.flag_votes;
drop policy if exists "judge votes on assigned live matches" on public.flag_votes;
create policy "judge votes on assigned live matches" on public.flag_votes for insert
with check (
  judge_id = auth.uid()
  and exists (
    select 1
    from public.matches m
    join public.categories c on c.id = m.category_id
    join public.competitions cp on cp.id = c.competition_id
    join public.judge_assignments ja on ja.id = flag_votes.assignment_id
    where m.id = flag_votes.match_id
      and ja.judge_id = auth.uid()
      and ja.active
      and ja.event_id = cp.event_id
      and ja.competition_id = cp.id
      and cp.model = 'digital_flags'
      and ja.ring_id = m.ring_id
      and (ja.category_id is null or ja.category_id = m.category_id)
      and m.status = 'live'
      and (
        (flag_votes.color = 'blue' and flag_votes.chosen_registration_id = m.blue_registration_id)
        or (flag_votes.color = 'green' and flag_votes.chosen_registration_id = m.green_registration_id)
      )
  )
);

-- Retorna somente confrontos da competição para a qual o juiz foi designado.
create or replace function public.judge_live_matches()
returns table (
  match_id uuid, assignment_id uuid, ring_name text, category_name text, phase text,
  blue_registration_id uuid, blue_name text, green_registration_id uuid, green_name text, voted boolean
)
language sql stable security definer set search_path = public as $$
  select m.id, ja.id, r.name, c.name, m.phase,
    m.blue_registration_id, blue.full_name, m.green_registration_id, green.full_name,
    exists(select 1 from public.flag_votes fv where fv.match_id = m.id and fv.judge_id = auth.uid())
  from public.matches m
  join public.rings r on r.id = m.ring_id
  join public.categories c on c.id = m.category_id
  join public.competitions cp on cp.id = c.competition_id
  join public.registrations rb on rb.id = m.blue_registration_id
  join public.participants blue on blue.id = rb.participant_id
  join public.registrations rg on rg.id = m.green_registration_id
  join public.participants green on green.id = rg.participant_id
  join lateral (
    select a.id
    from public.judge_assignments a
    where a.judge_id = auth.uid()
      and a.active
      and a.event_id = cp.event_id
      and a.competition_id = cp.id
      and a.ring_id = m.ring_id
      and (a.category_id is null or a.category_id = m.category_id)
    order by a.starts_at nulls first
    limit 1
  ) ja on true
  where m.status = 'live'
    and cp.model = 'digital_flags';
$$;

create or replace function public.finalize_match(target_match uuid)
returns table (
  winner_registration_id uuid,
  blue_votes integer,
  green_votes integer,
  judges_required integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  match_row record;
  required_total integer;
  submitted_total integer;
  blue_total integer;
  green_total integer;
  resolved_winner uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select m.id, m.status, m.ring_id, m.category_id,
    m.blue_registration_id, m.green_registration_id, cp.event_id, cp.id as competition_id, cp.model as competition_model
  into match_row
  from public.matches m
  join public.categories c on c.id = m.category_id
  join public.competitions cp on cp.id = c.competition_id
  where m.id = target_match
  for update of m;

  if not found then
    raise exception 'match not found';
  end if;
  if not public.can_manage_event(match_row.event_id) then
    raise exception 'not authorized to finalize this match';
  end if;
  if match_row.status <> 'live' then
    raise exception 'only a live match can be finalized';
  end if;
  if match_row.competition_model <> 'digital_flags'::public.competition_model then
    raise exception 'only digital flag matches can be finalized with this function';
  end if;

  with expected as (
    select distinct ja.judge_id
    from public.judge_assignments ja
    where ja.event_id = match_row.event_id
      and ja.competition_id = match_row.competition_id
      and ja.ring_id = match_row.ring_id
      and ja.active
      and (ja.category_id is null or ja.category_id = match_row.category_id)
  ), valid_votes as (
    select fv.judge_id, fv.color
    from public.flag_votes fv
    join expected on expected.judge_id = fv.judge_id
    where fv.match_id = match_row.id
  )
  select
    (select count(*) from expected)::integer,
    (select count(*) from valid_votes)::integer,
    (select count(*) from valid_votes where color = 'blue')::integer,
    (select count(*) from valid_votes where color = 'green')::integer
  into required_total, submitted_total, blue_total, green_total;

  if required_total < 3 then
    raise exception 'assign at least three active judges before finalizing this match';
  end if;
  if submitted_total <> required_total then
    raise exception 'waiting for all judges: % of % votes received', submitted_total, required_total;
  end if;
  if blue_total = green_total then
    raise exception 'the vote is tied; use the tie-break procedure before finalizing';
  end if;

  resolved_winner := case when blue_total > green_total then match_row.blue_registration_id else match_row.green_registration_id end;
  perform set_config('app.allow_match_finalize', 'true', true);
  update public.matches
  set status = 'finished', winner_registration_id = resolved_winner, finished_at = now()
  where id = match_row.id;

  return query select resolved_winner, blue_total, green_total, required_total;
end;
$$;

revoke all on function public.judge_live_matches() from public;
revoke all on function public.finalize_match(uuid) from public;
grant execute on function public.judge_live_matches() to authenticated;
grant execute on function public.finalize_match(uuid) to authenticated;

-- O telão recebe a quantidade de votos, mas não vê votos por cor antes da
-- finalização. Assim não influencia os juízes nem o público.
drop function if exists public.display_board(text);
create function public.display_board(session_pin text)
returns table (
  session_name text, event_name text, ring_name text, match_status text, phase text,
  blue_name text, green_name text, blue_votes bigint, green_votes bigint,
  votes_received bigint, judges_required bigint, winner_name text
)
language sql stable security definer set search_path = public as $$
  select ds.name, e.name, r.name, m.status, m.phase,
    blue.full_name, green.full_name,
    case when m.status = 'finished' then coalesce(votes.blue_votes, 0) else 0 end,
    case when m.status = 'finished' then coalesce(votes.green_votes, 0) else 0 end,
    coalesce(votes.received, 0),
    coalesce(judges.required, 0),
    case
      when m.status <> 'finished' then null
      when m.winner_registration_id = m.blue_registration_id then blue.full_name
      when m.winner_registration_id = m.green_registration_id then green.full_name
      else null
    end
  from public.display_sessions ds
  join public.events e on e.id = ds.event_id
  left join public.rings r on r.id = ds.ring_id
  left join lateral (
    select mm.*
    from public.matches mm
    join public.categories c on c.id = mm.category_id
    join public.competitions cp on cp.id = c.competition_id
    where cp.event_id = ds.event_id
      and (ds.ring_id is null or mm.ring_id = ds.ring_id)
    order by case mm.status when 'live' then 0 when 'finished' then 1 else 2 end,
      coalesce(mm.finished_at, mm.started_at) desc nulls last
    limit 1
  ) m on true
  left join public.categories mc on mc.id = m.category_id
  left join public.competitions mcp on mcp.id = mc.competition_id
  left join lateral (
    select
      count(*)::bigint as received,
      count(*) filter (where fv.color = 'blue')::bigint as blue_votes,
      count(*) filter (where fv.color = 'green')::bigint as green_votes
    from public.flag_votes fv
    where fv.match_id = m.id
  ) votes on true
  left join lateral (
    select count(distinct ja.judge_id)::bigint as required
    from public.judge_assignments ja
    where ja.event_id = mcp.event_id
      and ja.competition_id = mcp.id
      and ja.ring_id = m.ring_id
      and ja.active
      and (ja.category_id is null or ja.category_id = m.category_id)
  ) judges on true
  left join public.registrations rb on rb.id = m.blue_registration_id
  left join public.participants blue on blue.id = rb.participant_id
  left join public.registrations rg on rg.id = m.green_registration_id
  left join public.participants green on green.id = rg.participant_id
  where ds.pin = session_pin and ds.active;
$$;

grant execute on function public.display_board(text) to anon, authenticated;

-- Evita que dois telões recebam o mesmo PIN. A verificação preserva bancos
-- antigos que eventualmente já possuam uma duplicidade para não interromper
-- esta migration no dia do evento.
do $$
begin
  if not exists (
    select 1 from public.display_sessions group by pin having count(*) > 1
  ) then
    execute 'create unique index if not exists display_sessions_pin_unique_idx on public.display_sessions(pin)';
  end if;
end;
$$;

notify pgrst, 'reload schema';
