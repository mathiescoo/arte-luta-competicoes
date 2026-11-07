-- Validação temporária: nenhuma alteração será mantida.
BEGIN;

-- Normalized musicality scoring and administrative interventions.
--
-- A scorecard average is always kept on a 0-10 scale. This makes the result
-- comparable whether a category has one judge or many judges, and whether the
-- criteria use different valid ranges.

alter table public.scorecards
  add column if not exists admin_edited_by uuid references public.profiles,
  add column if not exists admin_edited_at timestamptz,
  add column if not exists admin_edit_reason text;

alter table public.scorecards
  drop constraint if exists scorecards_admin_edit_reason_length_check;
alter table public.scorecards
  add constraint scorecards_admin_edit_reason_length_check
  check (admin_edit_reason is null or char_length(admin_edit_reason) between 3 and 500);

create or replace function public.scorecard_normalized_average(target_scorecard uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select round(
    avg(
      ((score_item.score - criterion.min_score)
        / nullif(criterion.max_score - criterion.min_score, 0)
      ) * 10
    )::numeric,
    4
  )
  from public.score_items score_item
  join public.scoring_criteria criterion on criterion.id = score_item.criterion_id
  where score_item.scorecard_id = target_scorecard;
$$;

-- Once the organization has intervened, a judge cannot silently overwrite the
-- corrected scorecard. The manager can make further corrections through the
-- audited administrative RPC.
create or replace function public.protect_admin_scorecard_correction()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.admin_edited_at is not null
     and auth.uid() = old.judge_id
     and coalesce(current_setting('app.scoring_admin_adjustment', true), '') <> 'true' then
    raise exception 'this scorecard was corrected by the organization and is locked';
  end if;
  return new;
end;
$$;
drop trigger if exists protect_admin_scorecard_correction on public.scorecards;
create trigger protect_admin_scorecard_correction before update on public.scorecards
for each row execute function public.protect_admin_scorecard_correction();

-- Rebuilds a category ranking from the average of the assigned judges' scorecard
-- averages, instead of summing every criterion of every judge.
create or replace function public.homologate_scoring_results(target_category uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  target_event uuid;
  target_competition uuid;
  target_model public.competition_model;
  result_count integer := 0;
begin
  if actor_id is null then
    raise exception 'not authenticated';
  end if;

  select competition.event_id, competition.id, competition.model
  into target_event, target_competition, target_model
  from public.categories category
  join public.competitions competition on competition.id = category.competition_id
  where category.id = target_category;

  if target_event is null or not public.can_manage_event(target_event) then
    raise exception 'not authorized to generate this ranking';
  end if;
  if target_model <> 'sum_score'::public.competition_model then
    raise exception 'rankings can only be generated for sum_score competitions';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_category::text));
  perform 1
  from public.results result
  where result.category_id = target_category
  for update;

  if not exists (
    select 1
    from public.presentations presentation
    where presentation.category_id = target_category
  ) then
    raise exception 'generate the presentation order before generating results';
  end if;
  if exists (
    select 1
    from public.presentations presentation
    where presentation.category_id = target_category
      and presentation.status <> 'finished'
  ) then
    raise exception 'finish every presentation before generating the ranking';
  end if;
  if exists (
    select 1
    from public.results result
    where result.category_id = target_category
      and result.published_at is not null
  ) then
    raise exception 'published results cannot be replaced';
  end if;
  if (
    select count(distinct assignment.judge_id)
    from public.judge_assignments assignment
    where assignment.event_id = target_event
      and assignment.competition_id = target_competition
      and assignment.active
      and (assignment.category_id is null or assignment.category_id = target_category)
  ) < 1 then
    raise exception 'assign at least one active judge before generating the ranking';
  end if;
  if exists (
    select 1
    from public.presentations presentation
    where presentation.category_id = target_category
      and exists (
        select 1
        from public.judge_assignments assignment
        where assignment.event_id = target_event
          and assignment.competition_id = target_competition
          and assignment.active
          and (assignment.category_id is null or assignment.category_id = target_category)
          and not exists (
            select 1
            from public.scorecards card
            join public.judge_assignments card_assignment on card_assignment.id = card.assignment_id
            where card.presentation_id = presentation.id
              and card.judge_id = assignment.judge_id
              and card_assignment.active
              and card_assignment.event_id = target_event
              and card_assignment.competition_id = target_competition
              and (card_assignment.category_id is null or card_assignment.category_id = target_category)
          )
      )
  ) then
    raise exception 'every active judge must submit a scorecard for every presentation';
  end if;

  delete from public.results
  where category_id = target_category;

  with presentation_averages as (
    select
      presentation.registration_id,
      round(avg(public.scorecard_normalized_average(card.id))::numeric, 2) as total,
      count(card.id)::integer as judge_count
    from public.presentations presentation
    join public.scorecards card on card.presentation_id = presentation.id
    join public.judge_assignments assignment on assignment.id = card.assignment_id
    where presentation.category_id = target_category
      and assignment.active
      and assignment.event_id = target_event
      and assignment.competition_id = target_competition
      and (assignment.category_id is null or assignment.category_id = target_category)
    group by presentation.registration_id
  ), ranked as (
    select
      registration_id,
      total,
      judge_count,
      dense_rank() over (order by total desc)::integer as position
    from presentation_averages
  )
  insert into public.results(
    category_id, registration_id, position, total, homologated_at, homologated_by, details
  )
  select
    target_category,
    ranked.registration_id,
    ranked.position,
    ranked.total,
    now(),
    actor_id,
    jsonb_build_object(
      'source', 'sum_score',
      'calculation', 'normalized_judge_average',
      'score_scale', 10,
      'judge_count', ranked.judge_count
    )
  from ranked;

  get diagnostics result_count = row_count;
  return result_count;
end;
$$;

-- A manager can load every existing scorecard for an administrative correction.
create or replace function public.scoring_presentation_scorecards(target_presentation uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  target_event uuid;
  target_model public.competition_model;
  response jsonb;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select competition.event_id, competition.model
  into target_event, target_model
  from public.presentations presentation
  join public.categories category on category.id = presentation.category_id
  join public.competitions competition on competition.id = category.competition_id
  where presentation.id = target_presentation;

  if target_event is null or not public.can_manage_event(target_event) then
    raise exception 'not authorized to view these scorecards';
  end if;
  if target_model <> 'sum_score'::public.competition_model then
    raise exception 'only scoring scorecards can be viewed';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', card.id,
      'assignment_id', assignment.id,
      'judge_id', card.judge_id,
      'judge_name', profile.full_name,
      'submitted_at', card.submitted_at,
      'note', card.note,
      'scores', coalesce((
        select jsonb_object_agg(score_item.criterion_id::text, score_item.score)
        from public.score_items score_item
        where score_item.scorecard_id = card.id
      ), '{}'::jsonb)
    ) order by profile.full_name, card.submitted_at
  ), '[]'::jsonb)
  into response
  from public.scorecards card
  join public.judge_assignments assignment on assignment.id = card.assignment_id
  join public.profiles profile on profile.id = card.judge_id
  where card.presentation_id = target_presentation;

  return response;
end;
$$;

-- A manager can correct an existing judge's scorecard.
-- Each intervention needs a reason and remains traceable in both the scorecard
-- and the audit log. Published results are immutable.
create or replace function public.admin_adjust_scoring_scorecard(
  target_scorecard uuid,
  submitted_scores jsonb,
  submitted_note text default null,
  adjustment_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_event uuid;
  target_competition uuid;
  target_category uuid;
  target_model public.competition_model;
  presentation_status text;
  target_presentation uuid;
  target_assignment uuid;
  target_judge uuid;
  expected_criteria_count integer;
  score_input record;
  target_criterion uuid;
  score_value numeric;
  minimum numeric;
  maximum numeric;
  submitted_criteria uuid[] := array[]::uuid[];
  normalized_reason text := nullif(trim(coalesce(adjustment_reason, '')), '');
  average_score numeric;
  previous_scores jsonb;
  cleared_results integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if normalized_reason is null or char_length(normalized_reason) not between 3 and 500 then
    raise exception 'an intervention reason between 3 and 500 characters is required';
  end if;
  if submitted_scores is null or jsonb_typeof(submitted_scores) <> 'array' then
    raise exception 'submit one score for each criterion';
  end if;

  select presentation.category_id
  into target_category
  from public.scorecards card
  join public.presentations presentation on presentation.id = card.presentation_id
  where card.id = target_scorecard;

  if target_category is null then
    raise exception 'scorecard not found';
  end if;
  perform pg_advisory_xact_lock(hashtext(target_category::text));
  perform 1
  from public.results result
  where result.category_id = target_category
  for update;

  select
    competition.event_id,
    competition.id,
    competition.model,
    presentation.category_id,
    presentation.status,
    presentation.id,
    assignment.id,
    card.judge_id
  into
    target_event,
    target_competition,
    target_model,
    target_category,
    presentation_status,
    target_presentation,
    target_assignment,
    target_judge
  from public.scorecards card
  join public.presentations presentation on presentation.id = card.presentation_id
  join public.categories category on category.id = presentation.category_id
  join public.competitions competition on competition.id = category.competition_id
  join public.judge_assignments assignment on assignment.id = card.assignment_id
  where card.id = target_scorecard
    and assignment.active
    and assignment.event_id = competition.event_id
    and assignment.competition_id = competition.id
    and (assignment.category_id is null or assignment.category_id = category.id)
  for update of card, presentation, assignment;

  if target_event is null or not public.can_manage_event(target_event) then
    raise exception 'not authorized to edit this scorecard';
  end if;
  if target_model <> 'sum_score'::public.competition_model then
    raise exception 'only scoring scorecards can be edited';
  end if;
  if presentation_status not in ('live', 'finished') then
    raise exception 'open the presentation before editing its scorecard';
  end if;
  if exists (
    select 1
    from public.results result
    where result.category_id = target_category
      and result.published_at is not null
  ) then
    raise exception 'published results cannot be changed';
  end if;

  select count(*)
  into expected_criteria_count
  from public.scoring_criteria criterion
  where criterion.competition_id = target_competition;

  if expected_criteria_count = 0
    or jsonb_array_length(submitted_scores) <> expected_criteria_count then
    raise exception 'submit one score for each configured criterion';
  end if;

  for score_input in
    select value
    from jsonb_array_elements(submitted_scores)
  loop
    begin
      target_criterion := (score_input.value ->> 'criterion_id')::uuid;
      score_value := (score_input.value ->> 'score')::numeric;
    exception when invalid_text_representation then
      raise exception 'each submitted score must be numeric';
    end;

    if target_criterion is null or score_value is null then
      raise exception 'each criterion needs a score';
    end if;
    if target_criterion = any(submitted_criteria) then
      raise exception 'a criterion was submitted more than once';
    end if;

    select criterion.min_score, criterion.max_score
    into minimum, maximum
    from public.scoring_criteria criterion
    where criterion.id = target_criterion
      and criterion.competition_id = target_competition;

    if minimum is null or score_value < minimum or score_value > maximum then
      raise exception 'one of the submitted scores is outside the configured range';
    end if;
    submitted_criteria := array_append(submitted_criteria, target_criterion);
  end loop;

  select coalesce(jsonb_object_agg(item.criterion_id::text, item.score), '{}'::jsonb)
  into previous_scores from public.score_items item where item.scorecard_id = target_scorecard;
  perform set_config('app.scoring_admin_adjustment', 'true', true);
  update public.scorecards
  set
    note = nullif(left(trim(coalesce(submitted_note, '')), 1000), ''),
    admin_edited_by = auth.uid(),
    admin_edited_at = clock_timestamp(),
    admin_edit_reason = normalized_reason
  where id = target_scorecard;

  delete from public.score_items
  where scorecard_id = target_scorecard;

  for score_input in
    select value
    from jsonb_array_elements(submitted_scores)
  loop
    insert into public.score_items(scorecard_id, criterion_id, score)
    values (
      target_scorecard,
      (score_input.value ->> 'criterion_id')::uuid,
      (score_input.value ->> 'score')::numeric
    );
  end loop;

  average_score := public.scorecard_normalized_average(target_scorecard);

  delete from public.results
  where category_id = target_category;
  get diagnostics cleared_results = row_count;

  insert into public.audit_logs(actor_id, event_id, action, entity_type, entity_id, details)
  values (
    auth.uid(),
    target_event,
    'scoring_scorecard_admin_edited',
    'scorecard',
    target_scorecard,
    jsonb_build_object(
      'presentation_id', target_presentation,
      'assignment_id', target_assignment,
      'judge_id', target_judge,
      'reason', normalized_reason,
      'previous_scores', previous_scores,
      'new_scores', submitted_scores,
      'normalized_average', average_score,
      'results_invalidated', cleared_results
    )
  );

  return jsonb_build_object(
    'scorecard_id', target_scorecard,
    'normalized_average', average_score,
    'results_invalidated', cleared_results
  );
end;
$$;

-- Replaces the shared criteria only after explicitly resetting every evaluation
-- in that scoring competition. This is the safe last-minute correction path.
create or replace function public.replace_scoring_criteria_and_reset(
  target_competition uuid,
  criteria jsonb,
  reset_reason text,
  confirmed boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_event uuid;
  target_model public.competition_model;
  target_categories uuid[];
  category_id uuid;
  normalized_reason text := nullif(trim(coalesce(reset_reason, '')), '');
  deleted_scorecards integer := 0;
  deleted_results integer := 0;
  reset_presentations integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not confirmed then
    raise exception 'explicit confirmation is required to reset scoring criteria';
  end if;
  if normalized_reason is null or char_length(normalized_reason) not between 3 and 500 then
    raise exception 'a reset reason between 3 and 500 characters is required';
  end if;

  select competition.event_id, competition.model
  into target_event, target_model
  from public.competitions competition
  where competition.id = target_competition;

  if target_event is null or not public.can_manage_event(target_event) then
    raise exception 'not authorized to replace these scoring criteria';
  end if;
  if target_model <> 'sum_score'::public.competition_model then
    raise exception 'criteria reset is only available for scoring competitions';
  end if;

  select array_agg(category.id order by category.id)
  into target_categories
  from public.categories category
  where category.competition_id = target_competition;

  if coalesce(array_length(target_categories, 1), 0) = 0 then
    raise exception 'scoring competition has no categories';
  end if;

  foreach category_id in array target_categories loop
    perform pg_advisory_xact_lock(hashtext(category_id::text));
  end loop;

  perform 1
  from public.results result
  where result.category_id = any(target_categories)
  for update;

  perform 1
  from public.presentations presentation
  where presentation.category_id = any(target_categories)
  for update;

  if exists (
    select 1
    from public.results result
    where result.category_id = any(target_categories)
      and result.published_at is not null
  ) then
    raise exception 'published results prevent changing the scoring criteria';
  end if;

  delete from public.scorecards card
  using public.presentations presentation
  where card.presentation_id = presentation.id
    and presentation.category_id = any(target_categories);
  get diagnostics deleted_scorecards = row_count;

  delete from public.results result
  where result.category_id = any(target_categories);
  get diagnostics deleted_results = row_count;

  update public.presentations
  set
    status = 'waiting',
    timer_state = 'idle',
    timer_started_at = null,
    timer_ends_at = null,
    timer_paused_at = null,
    timer_remaining_seconds = timer_duration_seconds
  where category_id = any(target_categories);
  get diagnostics reset_presentations = row_count;

  -- The normal RPC validates every criterion and recreates the competition's
  -- criteria only after all dependent scorecards were safely removed above.
  perform public.replace_scoring_criteria(target_competition, criteria);

  insert into public.audit_logs(actor_id, event_id, action, entity_type, entity_id, details)
  values (
    auth.uid(),
    target_event,
    'scoring_criteria_replaced_with_reset',
    'competition',
    target_competition,
    jsonb_build_object(
      'reason', normalized_reason,
      'scorecards_deleted', deleted_scorecards,
      'results_invalidated', deleted_results,
      'presentations_reset', reset_presentations
    )
  );

  return jsonb_build_object(
    'scorecards_deleted', deleted_scorecards,
    'results_invalidated', deleted_results,
    'presentations_reset', reset_presentations
  );
end;
$$;

revoke all on function public.scorecard_normalized_average(uuid) from public;
revoke all on function public.homologate_scoring_results(uuid) from public;
revoke all on function public.scoring_presentation_scorecards(uuid) from public;
revoke all on function public.admin_adjust_scoring_scorecard(uuid, jsonb, text, text) from public;
revoke all on function public.replace_scoring_criteria_and_reset(uuid, jsonb, text, boolean) from public;

grant execute on function public.homologate_scoring_results(uuid) to authenticated;
grant execute on function public.scoring_presentation_scorecards(uuid) to authenticated;
grant execute on function public.admin_adjust_scoring_scorecard(uuid, jsonb, text, text) to authenticated;
grant execute on function public.replace_scoring_criteria_and_reset(uuid, jsonb, text, boolean) to authenticated;

notify pgrst, 'reload schema';

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

-- Keep presentation scores consistent with the normalized ranking and expose fixed judge seats.
create or replace function public.scoring_admin_workspace(target_event uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  workspace jsonb;
begin
  if auth.uid() is null or not public.can_manage_event(target_event) then
    raise exception 'not authorized to manage this scoring event';
  end if;

  select jsonb_build_object(
    'event', jsonb_build_object(
      'id', e.id,
      'name', e.name,
      'starts_at', e.starts_at,
      'status', e.status
    ),
    'competitions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', cp.id,
          'name', cp.name,
          'criteria', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', criterion.id,
                'name', criterion.name,
                'description', criterion.description,
                'min_score', criterion.min_score,
                'max_score', criterion.max_score,
                'sort_order', criterion.sort_order
              ) order by criterion.sort_order, criterion.name
            )
            from public.scoring_criteria criterion
            where criterion.competition_id = cp.id
          ), '[]'::jsonb),
          'categories', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', cat.id,
                'name', cat.name,
                'registration_count', (
                  select count(*)
                  from public.registrations registration
                  where registration.event_id = e.id
                    and registration.category_id = cat.id
                ),
                'active_judges', (
                  select count(distinct judge_assignment.judge_id)
                  from public.judge_assignments judge_assignment
                  where judge_assignment.event_id = e.id
                    and judge_assignment.competition_id = cp.id
                    and judge_assignment.active
                    and (judge_assignment.category_id is null or judge_assignment.category_id = cat.id)
                ),
                'presentations', coalesce((
                  select jsonb_agg(
                    jsonb_build_object(
                      'id', presentation.id,
                      'registration_id', presentation.registration_id,
                      'participant_name', participant.full_name,
                      'sort_order', presentation.sort_order,
                      'status', presentation.status,
                      'timer_duration_seconds', presentation.timer_duration_seconds,
                      'timer_state', presentation.timer_state,
                      'timer_started_at', presentation.timer_started_at,
                      'timer_ends_at', presentation.timer_ends_at,
                      'timer_paused_at', presentation.timer_paused_at,
                      'timer_remaining_seconds', case
                        when presentation.timer_state = 'running' and presentation.timer_ends_at is not null
                          then greatest(0, ceil(extract(epoch from presentation.timer_ends_at - now()))::integer)
                        else coalesce(presentation.timer_remaining_seconds, presentation.timer_duration_seconds)
                      end,
                      'submitted_scorecards', (
                        select count(distinct card.judge_id)
                        from public.scorecards card
                        where card.presentation_id = presentation.id
                          and exists (
                            select 1
                            from public.judge_assignments judge_assignment
                            where judge_assignment.id = card.assignment_id
                              and judge_assignment.active
                              and judge_assignment.event_id = e.id
                              and judge_assignment.competition_id = cp.id
                              and (judge_assignment.category_id is null or judge_assignment.category_id = cat.id)
                          )
                      ),
                      'total_score', (
                        select round(avg(public.scorecard_normalized_average(card.id))::numeric, 2)
                        from public.scorecards card
                        where card.presentation_id = presentation.id
                          and exists (
                            select 1
                            from public.judge_assignments judge_assignment
                            where judge_assignment.id = card.assignment_id
                              and judge_assignment.active
                              and judge_assignment.event_id = e.id
                              and judge_assignment.competition_id = cp.id
                              and (judge_assignment.category_id is null or judge_assignment.category_id = cat.id)
                          )
                      )
                    ) order by presentation.sort_order, participant.full_name
                  )
                  from public.presentations presentation
                  join public.registrations registration on registration.id = presentation.registration_id
                  join public.participants participant on participant.id = registration.participant_id
                  where presentation.category_id = cat.id
                ), '[]'::jsonb)
              ) order by cat.sort_order, cat.name
            )
            from public.categories cat
            where cat.competition_id = cp.id
          ), '[]'::jsonb)
        ) order by cp.name
      )
      from public.competitions cp
      where cp.event_id = e.id
        and cp.model = 'sum_score'
    ), '[]'::jsonb)
  )
  into workspace
  from public.events e
  where e.id = target_event;

  if workspace is null then
    raise exception 'scoring event not found';
  end if;

  return workspace;
end;
$$;

drop function if exists public.display_board(text);

create function public.display_board(session_pin text)
returns table (
  display_kind text,
  session_name text,
  event_name text,
  ring_name text,
  match_status text,
  phase text,
  blue_name text,
  green_name text,
  blue_votes bigint,
  green_votes bigint,
  votes_received bigint,
  judges_required bigint,
  winner_name text,
  competition_name text,
  category_name text,
  participant_name text,
  participant_age text,
  song_title text,
  song_author text,
  presentation_status text,
  timer_duration_seconds integer,
  timer_state text,
  timer_started_at timestamptz,
  timer_ends_at timestamptz,
  timer_paused_at timestamptz,
  timer_remaining_seconds integer,
  server_now timestamptz,
  queue_position integer,
  scorecards_received bigint,
  total_score numeric,
  judge_panels jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    case
      when scoring.presentation_status = 'live' then 'scoring'
      when match_data.status = 'live' then 'match'
      when scoring.presentation_id is not null then 'scoring'
      when match_data.id is not null then 'match'
      else 'idle'
    end as display_kind,
    ds.name as session_name,
    event.name as event_name,
    ring.name as ring_name,
    match_data.status as match_status,
    match_data.phase,
    blue_participant.full_name as blue_name,
    green_participant.full_name as green_name,
    case when match_data.status = 'finished' then coalesce(match_votes.blue_votes, 0) else 0 end as blue_votes,
    case when match_data.status = 'finished' then coalesce(match_votes.green_votes, 0) else 0 end as green_votes,
    coalesce(match_votes.received, 0) as votes_received,
    coalesce(scoring.judges_required, match_judges.required, 0) as judges_required,
    case
      when match_data.status <> 'finished' then null
      when match_data.winner_registration_id = match_data.blue_registration_id then blue_participant.full_name
      when match_data.winner_registration_id = match_data.green_registration_id then green_participant.full_name
      else null
    end as winner_name,
    scoring.competition_name,
    scoring.category_name,
    scoring.participant_name,
    scoring.participant_age,
    scoring.song_title,
    scoring.song_author,
    scoring.presentation_status,
    scoring.timer_duration_seconds,
    scoring.timer_state,
    scoring.timer_started_at,
    scoring.timer_ends_at,
    scoring.timer_paused_at,
    scoring.timer_remaining_seconds,
    now() as server_now,
    scoring.queue_position,
    coalesce(scoring.scorecards_received, 0) as scorecards_received,
    scoring.total_score,
    public.flag_match_judge_panels(match_data.id) as judge_panels
  from public.display_sessions ds
  join public.events event on event.id = ds.event_id
  left join public.rings ring on ring.id = ds.ring_id
  left join lateral (
    select
      presentation.id as presentation_id,
      presentation.status as presentation_status,
      presentation.sort_order as queue_position,
      competition.name as competition_name,
      category.name as category_name,
      participant.full_name as participant_name,
      coalesce(
        nullif(trim(registration.data ->> 'age'), ''),
        case
          when participant.birth_date is not null
            then extract(year from age(current_date, participant.birth_date))::integer::text
          else null
        end
      ) as participant_age,
      nullif(trim(registration.data ->> 'song_title'), '') as song_title,
      nullif(trim(registration.data ->> 'song_author'), '') as song_author,
      presentation.timer_duration_seconds,
      presentation.timer_state,
      presentation.timer_started_at,
      presentation.timer_ends_at,
      presentation.timer_paused_at,
      case
        when presentation.timer_state = 'running' and presentation.timer_ends_at is not null
          then greatest(0, ceil(extract(epoch from presentation.timer_ends_at - now()))::integer)
        else coalesce(presentation.timer_remaining_seconds, presentation.timer_duration_seconds)
      end as timer_remaining_seconds,
      scorecard_progress.received as scorecards_received,
      judge_progress.required as judges_required,
      case when presentation.status = 'finished' then score_total.total else null end as total_score
    from public.presentations presentation
    join public.categories category on category.id = presentation.category_id
    join public.competitions competition on competition.id = category.competition_id
      and competition.model = 'sum_score'::public.competition_model
    join public.registrations registration on registration.id = presentation.registration_id
    join public.participants participant on participant.id = registration.participant_id
    left join lateral (
      select
        count(*)::bigint as received,
        max(card.submitted_at) as last_submitted_at
      from public.scorecards card
      where card.presentation_id = presentation.id
    ) scorecard_progress on true
    left join lateral (
      select round(avg(public.scorecard_normalized_average(card.id))::numeric, 2) as total
      from public.scorecards card
      join public.judge_assignments assignment on assignment.id = card.assignment_id
      where card.presentation_id = presentation.id
        and assignment.active
        and assignment.event_id = competition.event_id
        and assignment.competition_id = competition.id
        and (assignment.category_id is null or assignment.category_id = category.id)
    ) score_total on true
    left join lateral (
      select count(distinct assignment.judge_id)::bigint as required
      from public.judge_assignments assignment
      where assignment.event_id = competition.event_id
        and assignment.competition_id = competition.id
        and assignment.active
        and (assignment.category_id is null or assignment.category_id = category.id)
    ) judge_progress on true
    where competition.event_id = ds.event_id
      and (
        ds.ring_id is null
        or not exists (
          select 1
          from public.competitions event_competition
          where event_competition.event_id = ds.event_id
            and event_competition.model = 'digital_flags'::public.competition_model
        )
      )
      and presentation.status in ('live', 'finished')
    order by
      case presentation.status when 'live' then 0 else 1 end,
      scorecard_progress.last_submitted_at desc nulls last,
      presentation.sort_order desc
    limit 1
  ) scoring on true
  left join lateral (
    select match_item.*
    from public.matches match_item
    join public.categories category on category.id = match_item.category_id
    join public.competitions competition on competition.id = category.competition_id
      and competition.model = 'digital_flags'::public.competition_model
    where competition.event_id = ds.event_id
      and (ds.ring_id is null or match_item.ring_id = ds.ring_id)
    order by
      case match_item.status when 'live' then 0 when 'finished' then 1 else 2 end,
      coalesce(match_item.finished_at, match_item.started_at) desc nulls last
    limit 1
  ) match_data on true
  left join public.categories match_category on match_category.id = match_data.category_id
  left join public.competitions match_competition on match_competition.id = match_category.competition_id
  left join lateral (
    select
      count(*)::bigint as received,
      count(*) filter (where vote.color = 'blue')::bigint as blue_votes,
      count(*) filter (where vote.color = 'green')::bigint as green_votes
    from public.flag_votes vote
    where vote.match_id = match_data.id
  ) match_votes on true
  left join lateral (
    select count(distinct assignment.judge_id)::bigint as required
    from public.judge_assignments assignment
    where assignment.event_id = match_competition.event_id
      and assignment.competition_id = match_competition.id
      and assignment.ring_id = match_data.ring_id
      and assignment.active
      and (assignment.category_id is null or assignment.category_id = match_data.category_id)
  ) match_judges on true
  left join public.registrations blue_registration on blue_registration.id = match_data.blue_registration_id
  left join public.participants blue_participant on blue_participant.id = blue_registration.participant_id
  left join public.registrations green_registration on green_registration.id = match_data.green_registration_id
  left join public.participants green_participant on green_participant.id = green_registration.participant_id
  where ds.pin = session_pin
    and ds.active;
$$;


revoke all on function public.display_board(text) from public;
grant execute on function public.display_board(text) to anon, authenticated;
notify pgrst, 'reload schema';

ROLLBACK;

