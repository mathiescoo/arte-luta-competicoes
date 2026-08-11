-- Fluxo de notas para competições do tipo sum_score (ex.: Cante Comigo).
-- Todas as leituras e gravações sensíveis são realizadas por RPCs com
-- autorização no banco, para que um juiz só enxergue sua própria avaliação.

alter table public.scoring_criteria enable row level security;
alter table public.presentations enable row level security;
alter table public.scorecards enable row level security;
alter table public.score_items enable row level security;

drop policy if exists "authorized score submission" on public.scorecards;

revoke all on table public.scoring_criteria from anon, authenticated;
revoke all on table public.presentations from anon, authenticated;
revoke all on table public.scorecards from anon, authenticated;
revoke all on table public.score_items from anon, authenticated;

create unique index if not exists presentations_category_registration_unique
  on public.presentations(category_id, registration_id);
create index if not exists scoring_criteria_competition_sort_idx
  on public.scoring_criteria(competition_id, sort_order);
create index if not exists presentations_category_sort_idx
  on public.presentations(category_id, sort_order);
create index if not exists scorecards_presentation_judge_idx
  on public.scorecards(presentation_id, judge_id);

create or replace function public.scoring_manageable_events()
returns table (id uuid, name text, starts_at timestamptz, status text)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.name, e.starts_at, e.status::text
  from public.events e
  where auth.uid() is not null
    and public.can_manage_event(e.id)
    and exists (
      select 1
      from public.competitions cp
      where cp.event_id = e.id
        and cp.model = 'sum_score'
    )
  order by e.starts_at nulls last, e.created_at desc;
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
                        select round(sum(score_item.score)::numeric, 2)
                        from public.scorecards card
                        join public.score_items score_item on score_item.scorecard_id = card.id
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

create or replace function public.replace_scoring_criteria(
  target_competition uuid,
  criteria jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_event uuid;
  target_model public.competition_model;
  criterion_input record;
  criterion_name text;
  minimum numeric;
  maximum numeric;
  criterion_names text[] := array[]::text[];
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select cp.event_id, cp.model
  into target_event, target_model
  from public.competitions cp
  where cp.id = target_competition;

  if target_event is null or not public.can_manage_event(target_event) then
    raise exception 'not authorized to configure scoring criteria';
  end if;
  if target_model <> 'sum_score'::public.competition_model then
    raise exception 'criteria can only be configured for sum_score competitions';
  end if;
  if criteria is null
    or jsonb_typeof(criteria) <> 'array'
    or jsonb_array_length(criteria) = 0
    or jsonb_array_length(criteria) > 12 then
    raise exception 'configure between 1 and 12 scoring criteria';
  end if;
  if exists (
    select 1
    from public.scorecards card
    join public.presentations presentation on presentation.id = card.presentation_id
    join public.categories cat on cat.id = presentation.category_id
    where cat.competition_id = target_competition
  ) then
    raise exception 'criteria cannot be changed after the first submitted scorecard';
  end if;

  for criterion_input in
    select value, ordinality
    from jsonb_array_elements(criteria) with ordinality
  loop
    criterion_name := nullif(trim(criterion_input.value ->> 'name'), '');
    begin
      minimum := coalesce(nullif(trim(criterion_input.value ->> 'min_score'), '')::numeric, 0);
      maximum := coalesce(nullif(trim(criterion_input.value ->> 'max_score'), '')::numeric, 10);
    exception when invalid_text_representation then
      raise exception 'criterion scores must be numeric';
    end;

    if criterion_name is null or char_length(criterion_name) > 80 then
      raise exception 'each criterion needs a name with up to 80 characters';
    end if;
    if lower(criterion_name) = any(criterion_names) then
      raise exception 'criterion names cannot be duplicated';
    end if;
    if minimum < 0 or maximum > 10 or minimum >= maximum then
      raise exception 'criterion ranges must be between 0 and 10';
    end if;

    criterion_names := array_append(criterion_names, lower(criterion_name));
  end loop;

  delete from public.scoring_criteria
  where competition_id = target_competition;

  for criterion_input in
    select value, ordinality
    from jsonb_array_elements(criteria) with ordinality
  loop
    insert into public.scoring_criteria(
      competition_id, name, description, min_score, max_score, sort_order
    )
    values (
      target_competition,
      trim(criterion_input.value ->> 'name'),
      nullif(trim(criterion_input.value ->> 'description'), ''),
      coalesce(nullif(trim(criterion_input.value ->> 'min_score'), '')::numeric, 0),
      coalesce(nullif(trim(criterion_input.value ->> 'max_score'), '')::numeric, 10),
      criterion_input.ordinality::integer - 1
    );
  end loop;
end;
$$;

create or replace function public.generate_scoring_presentations(target_category uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  target_event uuid;
  target_competition uuid;
  target_model public.competition_model;
  created_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select cp.event_id, cp.id, cp.model
  into target_event, target_competition, target_model
  from public.categories cat
  join public.competitions cp on cp.id = cat.competition_id
  where cat.id = target_category;

  if target_event is null or not public.can_manage_event(target_event) then
    raise exception 'not authorized to generate presentations';
  end if;
  if target_model <> 'sum_score'::public.competition_model then
    raise exception 'presentations can only be generated for sum_score competitions';
  end if;
  if not exists (
    select 1
    from public.scoring_criteria criterion
    where criterion.competition_id = target_competition
  ) then
    raise exception 'configure scoring criteria before generating the presentation order';
  end if;

  with current_max as (
    select coalesce(max(presentation.sort_order), 0) as base_order
    from public.presentations presentation
    where presentation.category_id = target_category
  ), pending_registrations as (
    select registration.id as registration_id,
      row_number() over (order by participant.full_name, registration.id) as queue_position
    from public.registrations registration
    join public.participants participant on participant.id = registration.participant_id
    where registration.event_id = target_event
      and registration.category_id = target_category
      and not exists (
        select 1
        from public.presentations presentation
        where presentation.category_id = target_category
          and presentation.registration_id = registration.id
      )
  )
  insert into public.presentations(category_id, registration_id, sort_order, status)
  select target_category,
    pending_registrations.registration_id,
    (current_max.base_order + pending_registrations.queue_position)::integer,
    'waiting'
  from pending_registrations
  cross join current_max
  on conflict (category_id, registration_id) do nothing;

  get diagnostics created_count = row_count;
  return created_count;
end;
$$;

create or replace function public.set_scoring_presentation_status(
  target_presentation uuid,
  next_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_event uuid;
  target_competition uuid;
  target_model public.competition_model;
  target_category uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if next_status is null or next_status not in ('waiting', 'live', 'finished') then
    raise exception 'invalid presentation status';
  end if;

  select cp.event_id, cp.id, cp.model, presentation.category_id
  into target_event, target_competition, target_model, target_category
  from public.presentations presentation
  join public.categories cat on cat.id = presentation.category_id
  join public.competitions cp on cp.id = cat.competition_id
  where presentation.id = target_presentation;

  if target_event is null or not public.can_manage_event(target_event) then
    raise exception 'not authorized to manage this presentation';
  end if;
  if target_model <> 'sum_score'::public.competition_model then
    raise exception 'presentation does not belong to a scoring competition';
  end if;
  if next_status = 'live' and not exists (
    select 1
    from public.scoring_criteria criterion
    where criterion.competition_id = target_competition
  ) then
    raise exception 'configure scoring criteria before opening an evaluation';
  end if;

  if next_status in ('live', 'finished') and (
    select count(distinct judge_assignment.judge_id)
    from public.judge_assignments judge_assignment
    where judge_assignment.event_id = target_event
      and judge_assignment.competition_id = target_competition
      and judge_assignment.active
      and (judge_assignment.category_id is null or judge_assignment.category_id = target_category)
  ) < 3 then
    raise exception 'assign at least three active judges to this category before opening or finishing an evaluation';
  end if;

  if next_status = 'finished' and exists (
    select 1
    from public.judge_assignments judge_assignment
    where judge_assignment.event_id = target_event
      and judge_assignment.competition_id = target_competition
      and judge_assignment.active
      and (judge_assignment.category_id is null or judge_assignment.category_id = target_category)
      and not exists (
        select 1
        from public.scorecards card
        join public.judge_assignments card_assignment on card_assignment.id = card.assignment_id
        where card.presentation_id = target_presentation
          and card.judge_id = judge_assignment.judge_id
          and card_assignment.active
          and card_assignment.event_id = target_event
          and card_assignment.competition_id = target_competition
          and (card_assignment.category_id is null or card_assignment.category_id = target_category)
      )
  ) then
    raise exception 'wait for every active judge to submit this scorecard before finishing the presentation';
  end if;

  if next_status = 'live' then
    update public.presentations
    set status = 'waiting'
    where category_id = target_category
      and status = 'live'
      and id <> target_presentation;
  end if;

  update public.presentations
  set status = next_status
  where id = target_presentation;
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
    and (assignment.category_id is null or assignment.category_id = cat.id);

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
  where criterion.competition_id = target_competition;

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
      and criterion.competition_id = target_competition;

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
        where criterion.competition_id = cp.id
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
      where criterion.competition_id = cp.id
    );

  return queue;
end;
$$;

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

  select cp.event_id, cp.id, cp.model
  into target_event, target_competition, target_model
  from public.categories cat
  join public.competitions cp on cp.id = cat.competition_id
  where cat.id = target_category;

  if target_event is null or not public.can_manage_event(target_event) then
    raise exception 'not authorized to generate this ranking';
  end if;
  if target_model <> 'sum_score'::public.competition_model then
    raise exception 'rankings can only be generated for sum_score competitions';
  end if;
  if not exists (
    select 1 from public.presentations presentation
    where presentation.category_id = target_category
  ) then
    raise exception 'generate the presentation order before generating results';
  end if;
  if exists (
    select 1 from public.presentations presentation
    where presentation.category_id = target_category
      and presentation.status <> 'finished'
  ) then
    raise exception 'finish every presentation before generating the ranking';
  end if;
  if (
    select count(distinct judge_assignment.judge_id)
    from public.judge_assignments judge_assignment
    where judge_assignment.event_id = target_event
      and judge_assignment.competition_id = target_competition
      and judge_assignment.active
      and (judge_assignment.category_id is null or judge_assignment.category_id = target_category)
  ) < 3 then
    raise exception 'assign at least three active judges before generating the ranking';
  end if;
  if exists (
    select 1
    from public.presentations presentation
    where presentation.category_id = target_category
      and exists (
        select 1
        from public.judge_assignments judge_assignment
        where judge_assignment.event_id = target_event
          and judge_assignment.competition_id = target_competition
          and judge_assignment.active
          and (judge_assignment.category_id is null or judge_assignment.category_id = target_category)
          and not exists (
            select 1
            from public.scorecards card
            join public.judge_assignments card_assignment on card_assignment.id = card.assignment_id
            where card.presentation_id = presentation.id
              and card.judge_id = judge_assignment.judge_id
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

  with presentation_totals as (
    select presentation.registration_id,
      round(sum(card_total.total)::numeric, 2) as total,
      count(card_total.total) as judge_count
    from public.presentations presentation
    join lateral (
      select sum(score_item.score) as total
      from public.scorecards card
      join public.score_items score_item on score_item.scorecard_id = card.id
      join public.judge_assignments judge_assignment on judge_assignment.id = card.assignment_id
      where card.presentation_id = presentation.id
        and judge_assignment.active
        and judge_assignment.event_id = target_event
        and judge_assignment.competition_id = target_competition
        and (judge_assignment.category_id is null or judge_assignment.category_id = target_category)
      group by card.id
    ) card_total on true
    where presentation.category_id = target_category
    group by presentation.registration_id
  ), ranked as (
    select registration_id,
      total,
      judge_count,
      dense_rank() over (order by total desc)::integer as position
    from presentation_totals
  )
  insert into public.results(
    category_id, registration_id, position, total, homologated_at, homologated_by, details
  )
  select target_category,
    ranked.registration_id,
    ranked.position,
    ranked.total,
    now(),
    actor_id,
    jsonb_build_object('source', 'sum_score', 'judge_count', ranked.judge_count)
  from ranked;

  get diagnostics result_count = row_count;
  return result_count;
end;
$$;

revoke all on function public.scoring_manageable_events() from public;
revoke all on function public.scoring_admin_workspace(uuid) from public;
revoke all on function public.replace_scoring_criteria(uuid, jsonb) from public;
revoke all on function public.generate_scoring_presentations(uuid) from public;
revoke all on function public.set_scoring_presentation_status(uuid, text) from public;
revoke all on function public.submit_scoring_scorecard(uuid, uuid, jsonb, text) from public;
revoke all on function public.scoring_judge_queue() from public;
revoke all on function public.homologate_scoring_results(uuid) from public;

grant execute on function public.scoring_manageable_events() to authenticated;
grant execute on function public.scoring_admin_workspace(uuid) to authenticated;
grant execute on function public.replace_scoring_criteria(uuid, jsonb) to authenticated;
grant execute on function public.generate_scoring_presentations(uuid) to authenticated;
grant execute on function public.set_scoring_presentation_status(uuid, text) to authenticated;
grant execute on function public.submit_scoring_scorecard(uuid, uuid, jsonb, text) to authenticated;
grant execute on function public.scoring_judge_queue() to authenticated;
grant execute on function public.homologate_scoring_results(uuid) to authenticated;

notify pgrst, 'reload schema';
