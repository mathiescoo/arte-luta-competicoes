-- Execute dentro de uma transação e termine com ROLLBACK.
-- Cria dados temporários para verificar notas antigas e novas sem mantê-los.
do $$
declare
  actor uuid;
  org uuid;
  event_id uuid := gen_random_uuid();
  competition_id uuid := gen_random_uuid();
  category_id uuid := gen_random_uuid();
  person_a uuid := gen_random_uuid();
  person_b uuid := gen_random_uuid();
  reg_a uuid := gen_random_uuid();
  reg_b uuid := gen_random_uuid();
  presentation_a uuid := gen_random_uuid();
  presentation_b uuid := gen_random_uuid();
  assignment_id uuid := gen_random_uuid();
  card_a uuid := gen_random_uuid();
  criterion_a uuid := gen_random_uuid();
  criterion_b uuid := gen_random_uuid();
  criterion_c uuid := gen_random_uuid();
  current_criteria jsonb;
  historic_cards jsonb;
  old_average numeric;
  new_average numeric;
  actual_count integer;
  blocked boolean := false;
begin
  select ur.user_id, ur.organization_id into actor, org
  from public.user_roles ur where ur.role = 'admin' limit 1;
  if actor is null then raise exception 'teste requer uma conta administradora existente'; end if;
  perform set_config('request.jwt.claim.sub', actor::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', actor::text, 'role', 'authenticated')::text, true);

  insert into public.events(id, organization_id, name, slug, created_by)
  values (event_id, org, 'Teste temporário de critérios', 'teste-' || event_id::text, actor);
  insert into public.competitions(id, event_id, name, model)
  values (competition_id, event_id, 'Teste temporário', 'sum_score');
  insert into public.categories(id, competition_id, name) values (category_id, competition_id, 'Teste');
  insert into public.participants(id, organization_id, full_name) values
    (person_a, org, 'Teste anterior'), (person_b, org, 'Teste posterior');
  insert into public.registrations(id, event_id, participant_id, category_id) values
    (reg_a, event_id, person_a, category_id), (reg_b, event_id, person_b, category_id);
  insert into public.judge_assignments(id, event_id, competition_id, category_id, judge_id)
  values (assignment_id, event_id, competition_id, category_id, actor);
  insert into public.scoring_criteria(id, competition_id, name, min_score, max_score, sort_order) values
    (criterion_a, competition_id, 'Primeiro', 0, 10, 1),
    (criterion_b, competition_id, 'Segundo', 0, 10, 2),
    (criterion_c, competition_id, 'Terceiro', 0, 10, 3);
  insert into public.presentations(id, category_id, registration_id, sort_order, status) values
    (presentation_a, category_id, reg_a, 1, 'finished'),
    (presentation_b, category_id, reg_b, 2, 'waiting');
  insert into public.scorecards(id, presentation_id, judge_id, assignment_id)
  values (card_a, presentation_a, actor, assignment_id);
  insert into public.score_items(scorecard_id, criterion_id, score) values
    (card_a, criterion_a, 6), (card_a, criterion_b, 8), (card_a, criterion_c, 10);
  old_average := public.scorecard_normalized_average(card_a);
  if old_average <> 8 then raise exception 'média inicial incorreta: %', old_average; end if;

  perform public.replace_scoring_criteria_preserving_history(competition_id,
    '[{"name":"Primeiro","min_score":0,"max_score":10},{"name":"Segundo","min_score":0,"max_score":10}]'::jsonb,
    'Teste temporário');
  if public.scorecard_normalized_average(card_a) <> old_average then
    raise exception 'a nota histórica foi alterada';
  end if;
  select count(*) into actual_count from public.score_items where scorecard_id = card_a;
  if actual_count <> 3 then raise exception 'a ficha histórica perdeu critérios'; end if;
  historic_cards := public.scoring_presentation_scorecards(presentation_a);
  if jsonb_array_length(historic_cards -> 0 -> 'criteria') <> 3 then
    raise exception 'a edição não recupera os critérios históricos';
  end if;
  current_criteria := public.scoring_admin_workspace(event_id) -> 'competitions' -> 0 -> 'criteria';
  if jsonb_array_length(current_criteria) <> 2 then raise exception 'critérios ativos incorretos'; end if;

  perform public.open_scoring_presentation(presentation_b);
  begin
    perform public.replace_scoring_criteria_preserving_history(competition_id,
      '[{"name":"Único","min_score":0,"max_score":10}]'::jsonb, 'Teste ao vivo');
  exception when others then
    if sqlerrm like '%finish the open presentation%' then blocked := true; else raise; end if;
  end;
  if not blocked then raise exception 'foi permitido alterar critérios durante apresentação aberta'; end if;
  perform public.submit_scoring_scorecard(presentation_b, assignment_id,
    jsonb_build_array(
      jsonb_build_object('criterion_id', current_criteria -> 0 ->> 'id', 'score', 6),
      jsonb_build_object('criterion_id', current_criteria -> 1 ->> 'id', 'score', 8)
    ), null);
  select public.scorecard_normalized_average(card.id) into new_average
  from public.scorecards card where card.presentation_id = presentation_b and card.judge_id = actor;
  if new_average <> 7 then raise exception 'média dos novos critérios incorreta: %', new_average; end if;
  if public.scorecard_normalized_average(card_a) <> 8 then raise exception 'nota antiga mudou após nova ficha'; end if;
end;
$$;
