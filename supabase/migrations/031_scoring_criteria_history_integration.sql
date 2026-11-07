-- Active criteria for future evaluations; historical scorecards retain their own criteria.
create or replace function public.scoring_judge_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  queue jsonb;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'event_id', e.id,
      'event_name', e.name,
      'competition_name', cp.name,
      'category_name', cat.name,
      'presentation_id', presentation.id,
      'assignment_id', assignment.id,
      'participant_name', participant.full_name,
      'participant_age', coalesce(
        nullif(trim(registration.data ->> 'age'), ''),
        case
          when participant.birth_date is not null
            then extract(year from age(current_date, participant.birth_date))::integer::text
          else null
        end
      ),
      'song_title', nullif(trim(registration.data ->> 'song_title'), ''),
      'song_author', nullif(trim(registration.data ->> 'song_author'), ''),
      'sort_order', presentation.sort_order,
      'status', presentation.status,
      'submitted', card.id is not null,
      'submitted_at', card.submitted_at,
      'note', card.note,
      'scores', coalesce((
        select jsonb_object_agg(score_item.criterion_id::text, score_item.score)
        from public.score_items score_item
        where score_item.scorecard_id = card.id
      ), '{}'::jsonb),
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
        where criterion.competition_id = cp.id and criterion.active
      ), '[]'::jsonb)
    ) order by e.starts_at nulls last, e.name, cp.name, cat.sort_order, presentation.sort_order
  ), '[]'::jsonb)
  into queue
  from public.presentations presentation
  join public.categories cat on cat.id = presentation.category_id
  join public.competitions cp on cp.id = cat.competition_id and cp.model = 'sum_score'
  join public.events e on e.id = cp.event_id
  join public.registrations registration on registration.id = presentation.registration_id
  join public.participants participant on participant.id = registration.participant_id
  join lateral (
    select judge_assignment.*
    from public.judge_assignments judge_assignment
    where judge_assignment.judge_id = auth.uid()
      and judge_assignment.active
      and judge_assignment.event_id = e.id
      and judge_assignment.competition_id = cp.id
      and (judge_assignment.category_id is null or judge_assignment.category_id = cat.id)
    order by (judge_assignment.category_id is null), judge_assignment.starts_at nulls first, judge_assignment.id
    limit 1
  ) assignment on true
  left join public.scorecards card
    on card.presentation_id = presentation.id
    and card.judge_id = auth.uid()
    and exists (
      select 1
      from public.judge_assignments card_assignment
      where card_assignment.id = card.assignment_id
        and card_assignment.active
        and card_assignment.event_id = e.id
        and card_assignment.competition_id = cp.id
        and (card_assignment.category_id is null or card_assignment.category_id = cat.id)
    )
  where presentation.status = 'live'
    and exists (
      select 1
      from public.scoring_criteria criterion
      where criterion.competition_id = cp.id and criterion.active
    );

  return queue;
end;
$$;

create or replace function public.submit_scoring_scorecard(
  target_presentation uuid,
  target_assignment uuid,
  submitted_scores jsonb,
  submitted_note text default null
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  target_competition uuid;
  target_status text;
  expected_criteria_count integer;
  score_input record;
  target_criterion uuid;
  score_value numeric;
  minimum numeric;
  maximum numeric;
  submitted_criteria uuid[] := array[]::uuid[];
  target_scorecard uuid;
  total_score numeric := 0;
begin
  if actor_id is null then
    raise exception 'not authenticated';
  end if;

  select cp.id, presentation.status
  into target_competition, target_status
  from public.presentations presentation
  join public.categories cat on cat.id = presentation.category_id
  join public.competitions cp on cp.id = cat.competition_id
  join public.judge_assignments assignment on assignment.id = target_assignment
  where presentation.id = target_presentation
    and cp.model = 'sum_score'
    and assignment.judge_id = actor_id
    and assignment.active
    and assignment.event_id = cp.event_id
    and assignment.competition_id = cp.id
    and (assignment.category_id is null or assignment.category_id = cat.id)
  for update of presentation;

  if target_competition is null then
    raise exception 'you are not assigned to evaluate this presentation';
  end if;
  if target_status <> 'live' then
    raise exception 'this presentation is not open for evaluation';
  end if;
  if submitted_scores is null or jsonb_typeof(submitted_scores) <> 'array' then
    raise exception 'submit one score for each criterion';
  end if;

  select count(*)
  into expected_criteria_count
  from public.scoring_criteria criterion
  where criterion.competition_id = target_competition and criterion.active;

  if expected_criteria_count = 0
    or jsonb_array_length(submitted_scores) <> expected_criteria_count then
    raise exception 'submit one score for each configured criterion';
  end if;

  for score_input in
    select value from jsonb_array_elements(submitted_scores)
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
      and criterion.competition_id = target_competition and criterion.active;

    if minimum is null or score_value < minimum or score_value > maximum then
      raise exception 'one of the submitted scores is outside the configured range';
    end if;

    submitted_criteria := array_append(submitted_criteria, target_criterion);
    total_score := total_score + score_value;
  end loop;

  insert into public.scorecards(
    presentation_id, judge_id, assignment_id, note, submitted_at
  )
  values (
    target_presentation,
    actor_id,
    target_assignment,
    nullif(left(trim(coalesce(submitted_note, '')), 1000), ''),
    now()
  )
  on conflict (presentation_id, judge_id)
  do update set
    assignment_id = excluded.assignment_id,
    note = excluded.note,
    submitted_at = excluded.submitted_at
  returning id into target_scorecard;

  delete from public.score_items
  where scorecard_id = target_scorecard;

  for score_input in
    select value from jsonb_array_elements(submitted_scores)
  loop
    insert into public.score_items(scorecard_id, criterion_id, score)
    values (
      target_scorecard,
      (score_input.value ->> 'criterion_id')::uuid,
      (score_input.value ->> 'score')::numeric
    );
  end loop;

  return round(total_score, 2);
end;
$$;

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
            where criterion.competition_id = cp.id and criterion.active
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
      'criteria', coalesce((
        select jsonb_agg(jsonb_build_object('id', criterion.id, 'name', criterion.name,
          'min_score', criterion.min_score, 'max_score', criterion.max_score)
          order by criterion.sort_order, criterion.name)
        from public.score_items item
        join public.scoring_criteria criterion on criterion.id = item.criterion_id
        where item.scorecard_id = card.id
      ), '[]'::jsonb),
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
  from public.score_items item
  where item.scorecard_id = target_scorecard;

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
      and criterion.competition_id = target_competition
      and exists (select 1 from public.score_items item
                  where item.scorecard_id = target_scorecard and item.criterion_id = criterion.id);

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

notify pgrst, 'reload schema';
