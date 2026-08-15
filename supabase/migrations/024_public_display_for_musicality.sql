-- O telÃ£o geral passa a reconhecer apresentaÃ§Ãµes de musicalidade sem criar
-- rodas ou confrontos. Quando houver uma apresentaÃ§Ã£o ao vivo, ela tem
-- prioridade; depois da conclusÃ£o, a Ãºltima apresentaÃ§Ã£o permanece visÃ­vel.

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

revoke all on function public.display_board(text) from public;
grant execute on function public.display_board(text) to anon, authenticated;

notify pgrst, 'reload schema';
