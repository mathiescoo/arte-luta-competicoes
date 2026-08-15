-- O Cante Comigo pode ser avaliado por um, dois, três ou mais jurados.
-- A regra obrigatória é ter ao menos um jurado ativo e receber a ficha de
-- todos os jurados ativos antes de concluir ou gerar a classificação.

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
  current_status text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if next_status is null or next_status not in ('waiting', 'live', 'finished') then
    raise exception 'invalid presentation status';
  end if;

  -- Serializa as ações de gestão de uma mesma categoria. Assim, duas
  -- apresentações não ficam abertas ao mesmo tempo por um clique simultâneo.
  -- O lock da categoria vem antes do lock da apresentação para não criar
  -- deadlock com cancelar/reiniciar outra apresentação da mesma categoria.
  select presentation.category_id
  into target_category
  from public.presentations presentation
  where presentation.id = target_presentation;

  if target_category is null then
    raise exception 'presentation not found';
  end if;
  perform pg_advisory_xact_lock(hashtext(target_category::text));

  select cp.event_id, cp.id, cp.model, presentation.category_id, presentation.status
  into target_event, target_competition, target_model, target_category, current_status
  from public.presentations presentation
  join public.categories cat on cat.id = presentation.category_id
  join public.competitions cp on cp.id = cat.competition_id
  where presentation.id = target_presentation
  for update of presentation;

  if target_event is null or not public.can_manage_event(target_event) then
    raise exception 'not authorized to manage this presentation';
  end if;
  if target_model <> 'sum_score'::public.competition_model then
    raise exception 'presentation does not belong to a scoring competition';
  end if;
  if current_status = next_status then
    return;
  end if;

  if next_status = 'live' and current_status <> 'waiting' then
    raise exception 'return the presentation to the queue before opening it again';
  end if;
  if next_status = 'finished' and current_status <> 'live' then
    raise exception 'only an open presentation can be finished';
  end if;
  if next_status = 'waiting' and current_status <> 'live' then
    raise exception 'use restart to return a finished evaluation to the queue';
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
  ) < 1 then
    raise exception 'assign at least one active judge to this category before opening or finishing an evaluation';
  end if;

  if next_status = 'live' and exists (
    select 1
    from public.scorecards card
    where card.presentation_id = target_presentation
  ) then
    raise exception 'restart this evaluation before opening it because it already has submitted scorecards';
  end if;

  if next_status = 'waiting' and exists (
    select 1
    from public.scorecards card
    where card.presentation_id = target_presentation
  ) then
    raise exception 'restart this evaluation to discard submitted scorecards before returning it to the queue';
  end if;

  -- Aguarda qualquer envio já iniciado na outra apresentação aberta antes de
  -- decidir se ela pode ser devolvida à fila.
  if next_status = 'live' then
    perform 1
    from public.presentations presentation
    where presentation.category_id = target_category
      and presentation.status = 'live'
      and presentation.id <> target_presentation
    for update;

    if exists (
      select 1
      from public.presentations presentation
      where presentation.category_id = target_category
        and presentation.status = 'live'
        and presentation.id <> target_presentation
        and exists (
          select 1
          from public.scorecards card
          where card.presentation_id = presentation.id
        )
    ) then
      raise exception 'finish or restart the currently open evaluation before opening another participant';
    end if;
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

  insert into public.audit_logs(actor_id, event_id, action, entity_type, entity_id, details)
  values (
    auth.uid(),
    target_event,
    case next_status
      when 'live' then 'scoring_presentation_opened'
      when 'finished' then 'scoring_presentation_finished'
      else 'scoring_presentation_opening_cancelled'
    end,
    'presentation',
    target_presentation,
    jsonb_build_object('from_status', current_status, 'to_status', next_status)
  );
end;
$$;

-- A apresentação é bloqueada durante o envio. Isso impede que uma ficha seja
-- salva depois que a organização cancelou ou reiniciou a avaliação.
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

-- Reiniciar apaga somente as fichas daquela apresentação, devolve a pessoa à
-- fila e invalida a classificação ainda não publicada da categoria.
create or replace function public.restart_scoring_presentation(target_presentation uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_event uuid;
  target_category uuid;
  target_model public.competition_model;
  cleared_scorecards integer := 0;
  cleared_results integer := 0;
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

  -- Faz uma publicaÃ§Ã£o concorrente aguardar antes de checar e remover a
  -- classificaÃ§Ã£o desta categoria.
  perform 1
  from public.results result
  where result.category_id = target_category
  for update;

  select cp.event_id, presentation.category_id, cp.model
  into target_event, target_category, target_model
  from public.presentations presentation
  join public.categories cat on cat.id = presentation.category_id
  join public.competitions cp on cp.id = cat.competition_id
  where presentation.id = target_presentation
  for update of presentation;

  if target_event is null or not public.can_manage_event(target_event) then
    raise exception 'not authorized to restart this presentation';
  end if;
  if target_model <> 'sum_score'::public.competition_model then
    raise exception 'only scoring presentations can be restarted';
  end if;

  if exists (
    select 1
    from public.results result
    where result.category_id = target_category
      and result.published_at is not null
  ) then
    raise exception 'this category already has published results and cannot be restarted';
  end if;

  delete from public.scorecards card
  where card.presentation_id = target_presentation;
  get diagnostics cleared_scorecards = row_count;

  delete from public.results result
  where result.category_id = target_category;
  get diagnostics cleared_results = row_count;

  update public.presentations
  set status = 'waiting'
  where id = target_presentation;

  insert into public.audit_logs(actor_id, event_id, action, entity_type, entity_id, details)
  values (
    auth.uid(),
    target_event,
    'scoring_presentation_restarted',
    'presentation',
    target_presentation,
    jsonb_build_object(
      'scorecards_deleted', cleared_scorecards,
      'results_invalidated', cleared_results
    )
  );

  return jsonb_build_object(
    'scorecards_deleted', cleared_scorecards,
    'results_invalidated', cleared_results
  );
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

  perform pg_advisory_xact_lock(hashtext(target_category::text));

  -- Protege a classificaÃ§Ã£o contra publicaÃ§Ã£o concorrente antes de decidir
  -- se os resultados podem ser substituÃ­dos.
  perform 1
  from public.results result
  where result.category_id = target_category
  for update;

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
  if exists (
    select 1
    from public.results result
    where result.category_id = target_category
      and result.published_at is not null
  ) then
    raise exception 'published results cannot be replaced';
  end if;
  if (
    select count(distinct judge_assignment.judge_id)
    from public.judge_assignments judge_assignment
    where judge_assignment.event_id = target_event
      and judge_assignment.competition_id = target_competition
      and judge_assignment.active
      and (judge_assignment.category_id is null or judge_assignment.category_id = target_category)
  ) < 1 then
    raise exception 'assign at least one active judge before generating the ranking';
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

-- Depois da primeira abertura, a escala fica protegida até a categoria ser
-- reiniciada. Isso impede que uma apresentação já concluída passe a exigir a
-- ficha de um juiz adicionado depois, ou perca a ficha de um juiz removido.
create or replace function public.assert_scoring_jury_unlocked(
  target_competition uuid,
  target_category uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if target_competition is null then
    return;
  end if;

  if exists (
    select 1
    from public.competitions competition
    where competition.id = target_competition
      and competition.model = 'sum_score'::public.competition_model
  ) and exists (
    select 1
    from public.presentations presentation
    join public.categories category on category.id = presentation.category_id
    where category.competition_id = target_competition
      and (target_category is null or presentation.category_id = target_category)
      and presentation.status in ('live', 'finished')
  ) then
    raise exception 'judge assignments are locked after the first scoring evaluation opens; restart every completed presentation in this category before changing the jury';
  end if;
end;
$$;

create or replace function public.protect_scoring_judge_assignments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.assert_scoring_jury_unlocked(old.competition_id, old.category_id);
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    perform public.assert_scoring_jury_unlocked(new.competition_id, new.category_id);
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_scoring_judge_assignments on public.judge_assignments;
create trigger protect_scoring_judge_assignments
before insert or update or delete on public.judge_assignments
for each row execute function public.protect_scoring_judge_assignments();

revoke all on function public.restart_scoring_presentation(uuid) from public;
revoke all on function public.assert_scoring_jury_unlocked(uuid, uuid) from public;
revoke all on function public.protect_scoring_judge_assignments() from public;
grant execute on function public.restart_scoring_presentation(uuid) to authenticated;

notify pgrst, 'reload schema';
