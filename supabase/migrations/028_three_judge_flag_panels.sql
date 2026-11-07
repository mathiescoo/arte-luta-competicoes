-- Three fixed judge seats for flag competitions.
--
-- Every flag match gets exactly three eligible judges when it starts. This
-- avoids changing the required vote count if assignments are edited later and
-- gives the display a stable three-seat progress board.

create table if not exists public.match_judge_slots (
  match_id uuid not null references public.matches on delete cascade,
  slot smallint not null check (slot between 1 and 3),
  judge_id uuid not null references public.profiles,
  assignment_id uuid not null references public.judge_assignments,
  created_at timestamptz not null default clock_timestamp(),
  primary key (match_id, slot),
  unique (match_id, judge_id),
  unique (match_id, assignment_id)
);

create index if not exists match_judge_slots_match_idx
  on public.match_judge_slots(match_id, slot);
create index if not exists match_judge_slots_judge_idx
  on public.match_judge_slots(judge_id, match_id);

alter table public.match_judge_slots enable row level security;
revoke all on table public.match_judge_slots from anon, authenticated;

-- Do not change the jury of an already running match during deployment.
do $$ begin
  if exists (select 1 from public.matches m join public.categories c on c.id = m.category_id join public.competitions cp on cp.id = c.competition_id where m.status = 'live' and cp.model = 'digital_flags') then
    raise exception 'finish all live flag matches before applying the three-judge upgrade';
  end if;
end $$;

-- Existing live matches are rare during deployment, but preserving the first
-- three eligible judges lets an in-progress event finish safely after upgrade.
with eligible as (
  select
    match_item.id as match_id,
    assignment.id as assignment_id,
    assignment.judge_id,
    assignment.starts_at,
    row_number() over (
      partition by match_item.id, assignment.judge_id
      order by assignment.starts_at nulls first, assignment.id
    ) as assignment_rank
  from public.matches match_item
  join public.categories category on category.id = match_item.category_id
  join public.competitions competition on competition.id = category.competition_id
  join public.judge_assignments assignment
    on assignment.event_id = competition.event_id
    and assignment.competition_id = competition.id
    and assignment.ring_id = match_item.ring_id
    and assignment.active
    and (assignment.category_id is null or assignment.category_id = match_item.category_id)
  where match_item.status = 'live'
    and competition.model = 'digital_flags'::public.competition_model
), chosen as (
  select
    match_id,
    assignment_id,
    judge_id,
    row_number() over (
      partition by match_id
      order by starts_at nulls first, assignment_id
    )::smallint as slot
  from eligible
  where assignment_rank = 1
)
insert into public.match_judge_slots(match_id, slot, judge_id, assignment_id)
select match_id, slot, judge_id, assignment_id
from chosen
where slot <= 3
on conflict do nothing;

-- A direct status update could otherwise bypass the snapshot. The existing
-- finalization trigger continues to guard the finished transition separately.
create or replace function public.prevent_unverified_match_start()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'waiting' then
      raise exception 'new matches must start in the waiting queue';
    end if;
    return new;
  end if;
  if new.status = 'live'
    and old.status is distinct from 'live'
    and coalesce(current_setting('app.allow_match_start', true), '') <> 'true' then
    raise exception 'matches must be started through start_flag_match';
  end if;

  if old.status = 'live'
    and (
      new.category_id is distinct from old.category_id
      or new.ring_id is distinct from old.ring_id
      or new.blue_registration_id is distinct from old.blue_registration_id
      or new.green_registration_id is distinct from old.green_registration_id
    ) then
    raise exception 'the participants, category and ring are locked after a match starts';
  end if;
  if old.status = 'live' and new.status not in ('live', 'finished') then
    raise exception 'a live match must be finalized before changing its status';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_match_start on public.matches;
create trigger protect_match_start
before insert or update on public.matches
for each row execute function public.prevent_unverified_match_start();

-- Starts a digital-flags match and snapshots exactly three judges. The query
-- takes the ring lock before the match row, keeping the same lock order for
-- starts and finalizations.
create or replace function public.start_flag_match(target_match uuid)
returns table (
  match_id uuid,
  started_at timestamptz,
  judges_required integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_ring uuid;
  match_row record;
  selected_count integer;
  transition_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select match_item.ring_id
  into target_ring
  from public.matches match_item
  where match_item.id = target_match;

  if target_ring is null then
    raise exception 'match not found';
  end if;
  perform pg_advisory_xact_lock(hashtext(target_ring::text));

  select
    match_item.id,
    match_item.status,
    match_item.ring_id,
    match_item.category_id,
    competition.event_id,
    competition.id as competition_id,
    competition.model as competition_model
  into match_row
  from public.matches match_item
  join public.categories category on category.id = match_item.category_id
  join public.competitions competition on competition.id = category.competition_id
  where match_item.id = target_match
  for update of match_item;

  if not found then
    raise exception 'match not found';
  end if;
  if not public.can_manage_event(match_row.event_id) then
    raise exception 'not authorized to start this match';
  end if;
  if match_row.competition_model <> 'digital_flags'::public.competition_model then
    raise exception 'only digital flag matches can be started here';
  end if;
  if match_row.status <> 'waiting' then
    raise exception 'only a waiting match can be started';
  end if;
  perform 1
  from public.matches live_match
  where live_match.ring_id = match_row.ring_id
    and live_match.status = 'live'
    and live_match.id <> target_match
  for update;
  if found then
    raise exception 'finish the live match in this ring before starting another one';
  end if;
  if exists (
    select 1
    from public.flag_votes vote
    where vote.match_id = target_match
  ) then
    raise exception 'this match already has votes and cannot be started again';
  end if;

  delete from public.match_judge_slots
  where match_id = target_match;

  with eligible as (
    select distinct on (assignment.judge_id)
      assignment.id as assignment_id,
      assignment.judge_id,
      assignment.starts_at
    from public.judge_assignments assignment
    where assignment.event_id = match_row.event_id
      and assignment.competition_id = match_row.competition_id
      and assignment.ring_id = match_row.ring_id
      and assignment.active
      and (assignment.category_id is null or assignment.category_id = match_row.category_id)
    order by assignment.judge_id, assignment.starts_at nulls first, assignment.id
  ), selected as (
    select
      assignment_id,
      judge_id,
      row_number() over (order by starts_at nulls first, assignment_id)::smallint as slot
    from eligible
    order by starts_at nulls first, assignment_id
    limit 3
  )
  insert into public.match_judge_slots(match_id, slot, judge_id, assignment_id)
  select target_match, slot, judge_id, assignment_id
  from selected;

  get diagnostics selected_count = row_count;
  if selected_count <> 3 then
    raise exception 'assign at least three active judges to this ring and category before starting the match';
  end if;

  transition_at := clock_timestamp();
  perform set_config('app.allow_match_start', 'true', true);
  update public.matches
  set status = 'live', started_at = transition_at
  where id = target_match;

  insert into public.audit_logs(actor_id, event_id, action, entity_type, entity_id, details)
  values (
    auth.uid(),
    match_row.event_id,
    'flag_match_started',
    'match',
    target_match,
    jsonb_build_object(
      'ring_id', match_row.ring_id,
      'category_id', match_row.category_id,
      'judges_required', 3,
      'judge_ids', (
        select jsonb_agg(slot.judge_id order by slot.slot)
        from public.match_judge_slots slot
        where slot.match_id = target_match
      )
    )
  );

  return query select target_match, transition_at, 3;
end;
$$;

-- A vote is valid only when it comes from the fixed seat selected at match
-- start. An assignment becoming inactive later does not invalidate a juror
-- already selected for this match.
drop policy if exists "judge votes on assigned live matches" on public.flag_votes;
drop policy if exists "authorized isolated vote" on public.flag_votes;
create or replace function public.can_cast_flag_vote(target_match uuid, target_assignment uuid, chosen uuid, selected_color text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select auth.uid() is not null and exists (
    select 1 from public.matches m
    join public.match_judge_slots slot on slot.match_id = m.id
    where m.id = target_match and m.status = 'live'
      and slot.judge_id = auth.uid() and slot.assignment_id = target_assignment
      and ((selected_color = 'blue' and chosen = m.blue_registration_id)
        or (selected_color = 'green' and chosen = m.green_registration_id))
  );
$$;
revoke all on function public.can_cast_flag_vote(uuid, uuid, uuid, text) from public;
grant execute on function public.can_cast_flag_vote(uuid, uuid, uuid, text) to authenticated;
drop policy if exists "judge votes from fixed match seat" on public.flag_votes;
create policy "judge votes from fixed match seat" on public.flag_votes for insert
with check (
  judge_id = auth.uid()
  and public.can_cast_flag_vote(match_id, assignment_id, chosen_registration_id, color)
);

-- Serialize each vote with finalization so a late vote cannot be committed
-- after the winner has already been determined.
create or replace function public.lock_flag_vote_match()
returns trigger language plpgsql security definer set search_path = public as $$
declare current_status text;
begin
  select status into current_status from public.matches where id = new.match_id for update;
  if current_status is distinct from 'live' then
    raise exception 'this match is no longer open for voting';
  end if;
  return new;
end;
$$;
drop trigger if exists lock_flag_vote_match on public.flag_votes;
create trigger lock_flag_vote_match before insert on public.flag_votes
for each row execute function public.lock_flag_vote_match();

-- Each judge receives only the live matches for their own frozen seat.
create or replace function public.judge_live_matches()
returns table (
  match_id uuid,
  assignment_id uuid,
  ring_name text,
  category_name text,
  phase text,
  blue_registration_id uuid,
  blue_name text,
  green_registration_id uuid,
  green_name text,
  voted boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    match_item.id,
    slot.assignment_id,
    ring.name,
    category.name,
    match_item.phase,
    match_item.blue_registration_id,
    blue_participant.full_name,
    match_item.green_registration_id,
    green_participant.full_name,
    exists (
      select 1
      from public.flag_votes vote
      where vote.match_id = match_item.id
        and vote.judge_id = auth.uid()
        and vote.assignment_id = slot.assignment_id
    )
  from public.matches match_item
  join public.match_judge_slots slot
    on slot.match_id = match_item.id
    and slot.judge_id = auth.uid()
  join public.rings ring on ring.id = match_item.ring_id
  join public.categories category on category.id = match_item.category_id
  join public.competitions competition on competition.id = category.competition_id
  join public.registrations blue_registration on blue_registration.id = match_item.blue_registration_id
  join public.participants blue_participant on blue_participant.id = blue_registration.participant_id
  join public.registrations green_registration on green_registration.id = match_item.green_registration_id
  join public.participants green_participant on green_participant.id = green_registration.participant_id
  where match_item.status = 'live'
    and competition.model = 'digital_flags'::public.competition_model;
$$;

-- This helper intentionally contains no color or identity information. The
-- public display can show three seat states without influencing another judge.
create or replace function public.flag_match_judge_panels(target_match uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'seat', judge_slot.slot,
        'voted', exists (
          select 1
          from public.flag_votes vote
          where vote.match_id = judge_slot.match_id
            and vote.judge_id = judge_slot.judge_id
            and vote.assignment_id = judge_slot.assignment_id
        ),
        'color', (
          select vote.color from public.flag_votes vote
          join public.matches match_item on match_item.id = vote.match_id
          where vote.match_id = judge_slot.match_id
            and vote.judge_id = judge_slot.judge_id
            and vote.assignment_id = judge_slot.assignment_id
            and match_item.status = 'finished'
          limit 1
        )
      )
      order by judge_slot.slot
    ),
    '[]'::jsonb
  )
  from public.match_judge_slots judge_slot
  where judge_slot.match_id = target_match;
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
  target_ring uuid;
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

  select match_item.ring_id
  into target_ring
  from public.matches match_item
  where match_item.id = target_match;

  if target_ring is null then
    raise exception 'match not found';
  end if;
  perform pg_advisory_xact_lock(hashtext(target_ring::text));

  select
    match_item.id,
    match_item.status,
    match_item.ring_id,
    match_item.category_id,
    match_item.blue_registration_id,
    match_item.green_registration_id,
    competition.event_id,
    competition.id as competition_id,
    competition.model as competition_model
  into match_row
  from public.matches match_item
  join public.categories category on category.id = match_item.category_id
  join public.competitions competition on competition.id = category.competition_id
  where match_item.id = target_match
  for update of match_item;

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

  select count(*)::integer
  into required_total
  from public.match_judge_slots slot
  where slot.match_id = target_match;

  if required_total <> 3 then
    raise exception 'this match must have exactly three frozen judge seats before finalizing';
  end if;

  select
    count(*)::integer,
    count(*) filter (where vote.color = 'blue')::integer,
    count(*) filter (where vote.color = 'green')::integer
  into submitted_total, blue_total, green_total
  from public.flag_votes vote
  join public.match_judge_slots slot
    on slot.match_id = vote.match_id
    and slot.judge_id = vote.judge_id
    and slot.assignment_id = vote.assignment_id
  where vote.match_id = target_match;

  if submitted_total <> required_total then
    raise exception 'waiting for all three judges: % of 3 votes received', submitted_total;
  end if;
  if blue_total = green_total then
    raise exception 'the vote is tied; use the tie-break procedure before finalizing';
  end if;

  resolved_winner := case
    when blue_total > green_total then match_row.blue_registration_id
    else match_row.green_registration_id
  end;

  perform set_config('app.allow_match_finalize', 'true', true);
  update public.matches
  set status = 'finished', winner_registration_id = resolved_winner, finished_at = clock_timestamp()
  where id = target_match;

  insert into public.audit_logs(actor_id, event_id, action, entity_type, entity_id, details)
  values (
    auth.uid(),
    match_row.event_id,
    'flag_match_finalized',
    'match',
    target_match,
    jsonb_build_object(
      'winner_registration_id', resolved_winner,
      'blue_votes', blue_total,
      'green_votes', green_total,
      'judges_required', 3
    )
  );

  return query select resolved_winner, blue_total, green_total, 3;
end;
$$;

revoke all on function public.start_flag_match(uuid) from public;
revoke all on function public.judge_live_matches() from public;
revoke all on function public.finalize_match(uuid) from public;
revoke all on function public.flag_match_judge_panels(uuid) from public;

grant execute on function public.start_flag_match(uuid) to authenticated;
grant execute on function public.judge_live_matches() to authenticated;
grant execute on function public.finalize_match(uuid) to authenticated;

notify pgrst, 'reload schema';
