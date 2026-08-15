-- Musicality presentation order and manual timer start.
--
-- The whole queue gets a single randomized order that remains stable and
-- contains every presentation exactly once. A singer can be announced on the
-- display before the organization starts the clock.

create or replace function public.open_scoring_presentation(target_presentation uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_event uuid;
  target_model public.competition_model;
  target_category uuid;
  current_status text;
  armed_at timestamptz;
  response jsonb;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select presentation.category_id
  into target_category
  from public.presentations presentation
  where presentation.id = target_presentation;

  if target_category is null then
    raise exception 'presentation not found';
  end if;
  perform pg_advisory_xact_lock(hashtext(target_category::text));

  select competition.event_id, competition.model, presentation.status
  into target_event, target_model, current_status
  from public.presentations presentation
  join public.categories category on category.id = presentation.category_id
  join public.competitions competition on competition.id = category.competition_id
  where presentation.id = target_presentation
  for update of presentation;

  if target_event is null or not public.can_manage_event(target_event) then
    raise exception 'not authorized to open this presentation';
  end if;
  if target_model <> 'sum_score'::public.competition_model then
    raise exception 'only scoring presentations can be opened this way';
  end if;
  if current_status <> 'waiting' then
    raise exception 'return the presentation to the queue before opening it again';
  end if;

  -- Keeps all existing judge, criteria and exclusivity validations. The status
  -- function also serializes this category.
  perform public.set_scoring_presentation_status(target_presentation, 'live');

  -- Judges can see the open evaluation, but the display first announces the
  -- singer. The clock stays armed and stopped until the organization starts it.
  armed_at := clock_timestamp();
  update public.presentations
  set
    timer_state = 'paused',
    timer_started_at = null,
    timer_ends_at = null,
    timer_paused_at = armed_at,
    timer_remaining_seconds = timer_duration_seconds
  where id = target_presentation
  returning jsonb_build_object(
    'timer_duration_seconds', timer_duration_seconds,
    'timer_state', timer_state,
    'timer_remaining_seconds', timer_remaining_seconds,
    'timer_started_at', timer_started_at
  ) into response;

  insert into public.audit_logs(actor_id, event_id, action, entity_type, entity_id, details)
  values (
    auth.uid(),
    target_event,
    'scoring_presentation_announced',
    'presentation',
    target_presentation,
    coalesce(response, '{}'::jsonb) || jsonb_build_object('armed_at', armed_at)
  );

  return coalesce(response, '{}'::jsonb);
end;
$$;

create or replace function public.shuffle_scoring_presentations(target_category uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  target_event uuid;
  target_model public.competition_model;
  shuffled_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select competition.event_id, competition.model
  into target_event, target_model
  from public.categories category
  join public.competitions competition on competition.id = category.competition_id
  where category.id = target_category;

  if target_event is null or not public.can_manage_event(target_event) then
    raise exception 'not authorized to organize this presentation order';
  end if;
  if target_model <> 'sum_score'::public.competition_model then
    raise exception 'only scoring categories can have a presentation draw';
  end if;

  -- The same category cannot be drawn or opened simultaneously.
  perform pg_advisory_xact_lock(hashtext(target_category::text));
  perform 1
  from public.presentations presentation
  where presentation.category_id = target_category
  for update;

  if not exists (
    select 1
    from public.presentations presentation
    where presentation.category_id = target_category
  ) then
    raise exception 'generate the presentation queue before drawing the order';
  end if;

  -- Once someone has been announced, started or received a score, the draw is
  -- locked to preserve the fairness and transparency of the published order.
  if exists (
    select 1
    from public.presentations presentation
    where presentation.category_id = target_category
      and presentation.status <> 'waiting'
  ) or exists (
    select 1
    from public.scorecards card
    join public.presentations presentation on presentation.id = card.presentation_id
    where presentation.category_id = target_category
  ) then
    raise exception 'the order can only be drawn before the first presentation is opened';
  end if;

  with drawn as (
    select
      presentation.id,
      row_number() over (order by random(), presentation.id)::integer as new_sort_order
    from public.presentations presentation
    where presentation.category_id = target_category
  )
  update public.presentations presentation
  set sort_order = drawn.new_sort_order
  from drawn
  where presentation.id = drawn.id;

  get diagnostics shuffled_count = row_count;

  insert into public.audit_logs(actor_id, event_id, action, entity_type, entity_id, details)
  values (
    auth.uid(),
    target_event,
    'scoring_presentations_shuffled',
    'category',
    target_category,
    jsonb_build_object('presentations', shuffled_count)
  );

  return shuffled_count;
end;
$$;

revoke all on function public.open_scoring_presentation(uuid) from public;
revoke all on function public.shuffle_scoring_presentations(uuid) from public;

grant execute on function public.open_scoring_presentation(uuid) to authenticated;
grant execute on function public.shuffle_scoring_presentations(uuid) to authenticated;

notify pgrst, 'reload schema';
