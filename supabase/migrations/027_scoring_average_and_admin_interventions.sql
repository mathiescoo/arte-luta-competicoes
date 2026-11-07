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
