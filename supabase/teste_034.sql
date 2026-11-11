-- Uso somente dentro de transação com ROLLBACK: todos os registros são temporários.
do $$
declare
  actor uuid; org uuid; current_event uuid := gen_random_uuid(); past_event uuid := gen_random_uuid();
  current_comp uuid := gen_random_uuid(); past_comp uuid := gen_random_uuid();
  current_cat uuid := gen_random_uuid(); past_cat uuid := gen_random_uuid();
  current_assignment uuid := gen_random_uuid(); past_assignment uuid := gen_random_uuid();
  display_id uuid := gen_random_uuid(); display_pin text; roster jsonb; blocked boolean := false;
begin
  select user_id, organization_id into actor, org from public.user_roles where role = 'admin' limit 1;
  if actor is null then raise exception 'teste requer administrador existente'; end if;
  if has_function_privilege('anon','public.event_judge_roster(uuid)','EXECUTE') then raise exception 'escala acessível indevidamente ao público'; end if;
  if not has_function_privilege('authenticated','public.event_judge_roster(uuid)','EXECUTE') then raise exception 'escala indisponível para usuários autenticados'; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claims',json_build_object('sub',actor::text,'role','authenticated')::text,true);
  insert into public.events(id,organization_id,name,slug,status,created_by) values
    (current_event,org,'Teste temporário atual','teste-atual-'||current_event::text,'preparing',actor),
    (past_event,org,'Teste temporário encerrado','teste-encerrado-'||past_event::text,'preparing',actor);
  insert into public.competitions(id,event_id,name,model) values
    (current_comp,current_event,'Avaliação temporária','sum_score'),(past_comp,past_event,'Avaliação anterior','sum_score');
  insert into public.categories(id,competition_id,name) values
    (current_cat,current_comp,'Categoria temporária'),(past_cat,past_comp,'Categoria anterior');
  insert into public.user_roles(user_id,organization_id,role) values(actor,org,'judge') on conflict do nothing;
  insert into public.event_users(event_id,user_id,role) values(current_event,actor,'judge'),(past_event,actor,'judge');
  insert into public.judge_assignments(id,event_id,competition_id,category_id,judge_id,active) values
    (current_assignment,current_event,current_comp,current_cat,actor,true),
    (past_assignment,past_event,past_comp,past_cat,actor,true);
  select lpad(value::text,6,'0') into display_pin from generate_series(100000,999999) value
    where not exists(select 1 from public.display_sessions ds where ds.pin=lpad(value::text,6,'0')) limit 1;
  insert into public.display_sessions(id,organization_id,event_id,name,pin,active)
    values(display_id,org,past_event,'Telão temporário',display_pin,true);
  roster := public.event_judge_roster(current_event);
  if jsonb_array_length(roster -> 'profiles') < 1 or jsonb_array_length(roster -> 'assignments') <> 1 then
    raise exception 'escala não retornou os juízes designados';
  end if;
  perform public.finalize_event_and_snapshot(past_event);
  if (select active from public.display_sessions where id = display_id) then raise exception 'telão não encerrou'; end if;
  perform public.manage_organization_access(actor,org,'judge',false);
  if exists(select 1 from public.user_roles where user_id=actor and organization_id=org and role='judge') then raise exception 'acesso de juiz não foi removido'; end if;
  if (select active from public.judge_assignments where id=current_assignment) then raise exception 'designação ativa não foi desativada'; end if;
  if not (select active from public.judge_assignments where id=past_assignment) then raise exception 'histórico de designação foi alterado'; end if;
  if exists(select 1 from public.event_users where user_id=actor and event_id in (current_event,past_event) and role='judge') then raise exception 'vínculo de juiz permaneceu ativo'; end if;
  if not public.event_closure_report_exists(past_event) then raise exception 'relatório histórico foi perdido'; end if;
  begin
    update public.display_sessions set active=true where id=display_id;
  exception when others then
    if sqlerrm like '%cannot activate a display for a finished event%' then blocked := true; else raise; end if;
  end;
  if not blocked then raise exception 'telão de evento finalizado foi reativado'; end if;
end;
$$;
