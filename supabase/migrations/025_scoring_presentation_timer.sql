-- Cronômetro de apresentações de musicalidade.
--
-- A fonte de tempo é o servidor: o telão recebe o horário de término e faz
-- somente a contagem visual. Pausas e reinícios persistem no banco, portanto
-- todos os telões e a organização ficam sincronizados.

alter table public.presentations
  add column if not exists timer_duration_seconds integer not null default 240,
  add column if not exists timer_state text not null default 'idle',
  add column if not exists timer_started_at timestamptz,
  add column if not exists timer_ends_at timestamptz,
  add column if not exists timer_paused_at timestamptz,
  add column if not exists timer_remaining_seconds integer;

-- Apresentações existentes ainda não tinham relógio. Mantém a duração padrão
-- e, se uma avaliação já estava aberta durante a migração, inicia seus quatro
-- minutos a partir deste momento, em vez de criar uma data fictícia.
update public.presentations
set
  timer_duration_seconds = coalesce(timer_duration_seconds, 240),
  timer_remaining_seconds = coalesce(timer_remaining_seconds, timer_duration_seconds, 240);

update public.presentations
set
  timer_state = 'running',
  timer_started_at = coalesce(timer_started_at, now()),
  timer_ends_at = coalesce(
    timer_ends_at,
    now() + timer_duration_seconds * interval '1 second'
  ),
  timer_paused_at = null,
  timer_remaining_seconds = coalesce(timer_remaining_seconds, timer_duration_seconds)
where status = 'live'
  and timer_state = 'idle';

alter table public.presentations
  drop constraint if exists presentations_timer_duration_seconds_check;
alter table public.presentations
  add constraint presentations_timer_duration_seconds_check
  check (timer_duration_seconds between 30 and 3600);

alter table public.presentations
  drop constraint if exists presentations_timer_state_check;
alter table public.presentations
  add constraint presentations_timer_state_check
  check (timer_state in ('idle', 'running', 'paused'));

alter table public.presentations
  drop constraint if exists presentations_timer_remaining_seconds_check;
alter table public.presentations
  add constraint presentations_timer_remaining_seconds_check
  check (
    timer_remaining_seconds is null
    or timer_remaining_seconds between 0 and timer_duration_seconds
  );

create index if not exists presentations_live_timer_idx
  on public.presentations(category_id, timer_ends_at)
  where status = 'live';

-- Abrir uma apresentação cria um novo relógio no servidor. Cancelar a abertura
-- e concluir uma apresentação param o relógio; reiniciar a avaliação devolve-o
-- ao estado inicial mais abaixo.
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
  transition_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if next_status is null or next_status not in ('waiting', 'live', 'finished') then
    raise exception 'invalid presentation status';
  end if;

  -- Serializa ações de uma mesma categoria para não haver duas avaliações
  -- abertas, nem dois cronômetros em execução, ao mesmo tempo.
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

  -- Usa o relÃ³gio real somente depois de aguardar os locks da categoria e da
  -- apresentaÃ§Ã£o. Assim, nenhum segundo Ã© perdido se a operaÃ§Ã£o esperar por
  -- uma nota que estava sendo salva.
  transition_at := clock_timestamp();

  if next_status = 'live' then
    update public.presentations
    set
      status = 'waiting',
      timer_state = 'idle',
      timer_started_at = null,
      timer_ends_at = null,
      timer_paused_at = null,
      timer_remaining_seconds = timer_duration_seconds
    where category_id = target_category
      and status = 'live'
      and id <> target_presentation;
  end if;

  update public.presentations
  set
    status = next_status,
    timer_state = case
      when next_status = 'live' then 'running'
      else 'idle'
    end,
    timer_started_at = case
      when next_status = 'live' then transition_at
      when next_status = 'waiting' then null
      else timer_started_at
    end,
    timer_ends_at = case
      when next_status = 'live' then transition_at + timer_duration_seconds * interval '1 second'
      else null
    end,
    timer_paused_at = null,
    timer_remaining_seconds = case
      when next_status = 'live' then timer_duration_seconds
      when next_status = 'waiting' then timer_duration_seconds
      when timer_state = 'running' and timer_ends_at is not null
        then greatest(0, ceil(extract(epoch from timer_ends_at - transition_at))::integer)
      else coalesce(timer_remaining_seconds, timer_duration_seconds)
    end
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
    jsonb_build_object(
      'from_status', current_status,
      'to_status', next_status,
      'timer_started_at', case when next_status = 'live' then transition_at else null end
    )
  );
end;
$$;

-- Controles do relógio. Só a organização pode pausar, retomar, reiniciar ou
-- alterar a duração. A duração aceita de 30 segundos a 60 minutos e começa
-- em 240 segundos (quatro minutos).
create or replace function public.manage_scoring_presentation_timer(
  target_presentation uuid,
  action text,
  duration_seconds integer default null
)
returns jsonb
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
  current_timer_state text;
  current_duration integer;
  current_remaining integer;
  current_ends_at timestamptz;
  normalized_action text := lower(trim(coalesce(action, '')));
  transition_at timestamptz;
  remaining_seconds integer;
  response jsonb;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if normalized_action not in ('pause', 'resume', 'restart', 'set_duration') then
    raise exception 'invalid timer action';
  end if;

  select presentation.category_id
  into target_category
  from public.presentations presentation
  where presentation.id = target_presentation;

  if target_category is null then
    raise exception 'presentation not found';
  end if;
  perform pg_advisory_xact_lock(hashtext(target_category::text));

  select
    competition.event_id,
    competition.id,
    competition.model,
    presentation.category_id,
    presentation.status,
    presentation.timer_state,
    presentation.timer_duration_seconds,
    presentation.timer_remaining_seconds,
    presentation.timer_ends_at
  into
    target_event,
    target_competition,
    target_model,
    target_category,
    current_status,
    current_timer_state,
    current_duration,
    current_remaining,
    current_ends_at
  from public.presentations presentation
  join public.categories category on category.id = presentation.category_id
  join public.competitions competition on competition.id = category.competition_id
  where presentation.id = target_presentation
  for update of presentation;

  if target_event is null or not public.can_manage_event(target_event) then
    raise exception 'not authorized to manage this presentation timer';
  end if;
  if target_model <> 'sum_score'::public.competition_model then
    raise exception 'timer controls are only available for scoring presentations';
  end if;
  if current_status not in ('waiting', 'live') then
    raise exception 'timer cannot be changed after the presentation is finished';
  end if;
  if normalized_action <> 'set_duration' and current_status <> 'live' then
    raise exception 'open the presentation before controlling its timer';
  end if;

  if normalized_action = 'set_duration' then
    if duration_seconds is null or duration_seconds not between 30 and 3600 then
      raise exception 'timer duration must be between 30 and 3600 seconds';
    end if;
  elsif duration_seconds is not null then
    raise exception 'duration_seconds is only accepted with set_duration';
  end if;

  -- O instante de transiÃ§Ã£o Ã© capturado apÃ³s os locks, para que pausa,
  -- retomada e reinÃ­cio nÃ£o percam segundos em uma disputa de concorrÃªncia.
  transition_at := clock_timestamp();

  remaining_seconds := case
    when current_timer_state = 'running' and current_ends_at is not null
      then greatest(0, ceil(extract(epoch from current_ends_at - transition_at))::integer)
    else coalesce(current_remaining, current_duration)
  end;

  if normalized_action = 'pause' then
    if current_timer_state <> 'running' then
      raise exception 'timer is not running';
    end if;

    update public.presentations
    set
      timer_state = 'paused',
      timer_ends_at = null,
      timer_paused_at = transition_at,
      timer_remaining_seconds = remaining_seconds
    where id = target_presentation;
  elsif normalized_action = 'resume' then
    if current_timer_state <> 'paused' then
      raise exception 'timer is not paused';
    end if;

    update public.presentations
    set
      timer_state = 'running',
      timer_started_at = transition_at,
      timer_ends_at = transition_at + remaining_seconds * interval '1 second',
      timer_paused_at = null,
      timer_remaining_seconds = remaining_seconds
    where id = target_presentation;
  elsif normalized_action = 'restart' then
    update public.presentations
    set
      timer_state = 'running',
      timer_started_at = transition_at,
      timer_ends_at = transition_at + timer_duration_seconds * interval '1 second',
      timer_paused_at = null,
      timer_remaining_seconds = timer_duration_seconds
    where id = target_presentation;
  else
    -- Alterar a duração também reinicia o relógio para que a alteração seja
    -- previsível para os jurados e para todos os telões conectados.
    if current_status = 'live' and current_timer_state = 'running' then
      update public.presentations
      set
        timer_duration_seconds = duration_seconds,
        timer_state = 'running',
        timer_started_at = transition_at,
        timer_ends_at = transition_at + duration_seconds * interval '1 second',
        timer_paused_at = null,
        timer_remaining_seconds = duration_seconds
      where id = target_presentation;
    elsif current_status = 'live' then
      update public.presentations
      set
        timer_duration_seconds = duration_seconds,
        timer_state = 'paused',
        timer_started_at = null,
        timer_ends_at = null,
        timer_paused_at = transition_at,
        timer_remaining_seconds = duration_seconds
      where id = target_presentation;
    else
      update public.presentations
      set
        timer_duration_seconds = duration_seconds,
        timer_state = 'idle',
        timer_started_at = null,
        timer_ends_at = null,
        timer_paused_at = null,
        timer_remaining_seconds = duration_seconds
      where id = target_presentation;
    end if;
  end if;

  select jsonb_build_object(
    'timer_duration_seconds', presentation.timer_duration_seconds,
    'timer_state', presentation.timer_state,
    'timer_started_at', presentation.timer_started_at,
    'timer_ends_at', presentation.timer_ends_at,
    'timer_paused_at', presentation.timer_paused_at,
    'timer_remaining_seconds', case
      when presentation.timer_state = 'running' and presentation.timer_ends_at is not null
        then greatest(0, ceil(extract(epoch from presentation.timer_ends_at - now()))::integer)
      else coalesce(presentation.timer_remaining_seconds, presentation.timer_duration_seconds)
    end
  )
  into response
  from public.presentations presentation
  where presentation.id = target_presentation;

  insert into public.audit_logs(actor_id, event_id, action, entity_type, entity_id, details)
  values (
    auth.uid(),
    target_event,
    'scoring_presentation_timer_' || normalized_action,
    'presentation',
    target_presentation,
    response
  );

  return response;
end;
$$;

-- Nome alternativo mantido para integrações que usem o termo "control".
-- A verificação de organização continua concentrada na função principal.
create or replace function public.control_scoring_presentation_timer(
  target_presentation uuid,
  action text,
  duration_seconds integer default null
)
returns jsonb
language sql
security invoker
set search_path = public
as $$
  select public.manage_scoring_presentation_timer(
    target_presentation,
    action,
    duration_seconds
  );
$$;

-- Reiniciar a avaliação descarta fichas e também deixa o relógio parado,
-- preparado para iniciar novamente do tempo configurado ao abrir a pessoa.
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
  set
    status = 'waiting',
    timer_state = 'idle',
    timer_started_at = null,
    timer_ends_at = null,
    timer_paused_at = null,
    timer_remaining_seconds = timer_duration_seconds
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
      'results_invalidated', cleared_results,
      'timer_reset', true
    )
  );

  return jsonb_build_object(
    'scorecards_deleted', cleared_scorecards,
    'results_invalidated', cleared_results,
    'timer_reset', true
  );
end;
$$;

-- A área administrativa recebe o estado do relógio calculado no servidor.
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

-- O telão recebe o mesmo relógio, incluindo o término absoluto que permite
-- uma contagem contínua mesmo entre atualizações de rede.
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
  total_score numeric
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
    scoring.total_score
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
      select round(coalesce(sum(score_item.score), 0)::numeric, 2) as total
      from public.scorecards card
      join public.score_items score_item on score_item.scorecard_id = card.id
      where card.presentation_id = presentation.id
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

revoke all on function public.set_scoring_presentation_status(uuid, text) from public;
revoke all on function public.restart_scoring_presentation(uuid) from public;
revoke all on function public.manage_scoring_presentation_timer(uuid, text, integer) from public;
revoke all on function public.control_scoring_presentation_timer(uuid, text, integer) from public;
revoke all on function public.scoring_admin_workspace(uuid) from public;
revoke all on function public.display_board(text) from public;

grant execute on function public.set_scoring_presentation_status(uuid, text) to authenticated;
grant execute on function public.restart_scoring_presentation(uuid) to authenticated;
grant execute on function public.manage_scoring_presentation_timer(uuid, text, integer) to authenticated;
grant execute on function public.control_scoring_presentation_timer(uuid, text, integer) to authenticated;
grant execute on function public.scoring_admin_workspace(uuid) to authenticated;
grant execute on function public.display_board(text) to anon, authenticated;

notify pgrst, 'reload schema';
