-- Dados que identificam cada intérprete no momento da avaliação.
-- Eles ficam na inscrição do evento para preservar a música e a idade informadas
-- para aquela edição, sem expor telefone ou outros dados privados aos jurados.

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

revoke all on function public.scoring_judge_queue() from public;
grant execute on function public.scoring_judge_queue() to authenticated;

notify pgrst, 'reload schema';
