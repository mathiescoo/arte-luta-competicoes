-- Teste temporário: NÃO troque ROLLBACK por COMMIT.
begin;

-- Preserve histórico de eventos fechados e permite retirar o acesso de juízes.
-- Não apaga pessoas, fichas, votos ou designações históricas.

create or replace function public.manage_organization_access(
  target_user uuid, target_organization uuid, target_role public.app_role, enabled boolean
) returns void language plpgsql security definer set search_path = public as $$
declare actor_id uuid := auth.uid(); admin_total integer;
begin
  if actor_id is null or not public.is_admin(target_organization) then
    raise exception 'not authorized to manage this organization';
  end if;
  if target_role = 'admin' and not enabled then
    select count(*) into admin_total from public.user_roles
      where organization_id = target_organization and role = 'admin';
    if target_user = actor_id then raise exception 'you cannot remove your own administrator access'; end if;
    if admin_total <= 1 then raise exception 'the organization must keep at least one administrator'; end if;
  end if;
  if target_role = 'admin' and enabled and not exists (
    select 1 from public.user_roles where organization_id = target_organization and user_id = target_user
  ) then raise exception 'the user must already belong to the organization before becoming administrator'; end if;

  if enabled then
    insert into public.user_roles(user_id, organization_id, role)
    values(target_user, target_organization, target_role) on conflict do nothing;
  else
    if target_role = 'judge' then
      -- A escala em andamento continua protegida pelos gatilhos existentes.
      -- Caso ela não possa ser alterada, toda a remoção é revertida.
      update public.judge_assignments ja set active = false
      where ja.judge_id = target_user and ja.active and exists (
        select 1 from public.events e where e.id = ja.event_id
          and e.organization_id = target_organization and e.status not in ('finished','archived')
          and not exists(select 1 from public.event_closure_reports report where report.event_id = e.id)
      );
      delete from public.event_users eu using public.events e
      where eu.event_id = e.id and e.organization_id = target_organization
        and eu.user_id = target_user and eu.role = 'judge';
      update public.judge_applications set status = 'rejected', reviewed_at = now()
        where user_id = target_user and organization_id = target_organization and status = 'approved';
    end if;
    delete from public.user_roles where user_id = target_user
      and organization_id = target_organization and role = target_role;
  end if;
  if target_role = 'judge' and enabled then
    update public.judge_applications set status = 'approved', reviewed_at = now()
    where user_id = target_user and organization_id = target_organization and status in ('pending','rejected');
  end if;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values(actor_id, case when enabled then 'access_granted' else 'access_removed' end,
    'user_role', target_user, jsonb_build_object('organization_id',target_organization,'role',target_role));
end;
$$;
revoke all on function public.manage_organization_access(uuid, uuid, public.app_role, boolean) from public, anon, authenticated;
grant execute on function public.manage_organization_access(uuid, uuid, public.app_role, boolean) to authenticated;

-- Apenas administradores e organizadores autorizados podem consultar a escala.
create or replace function public.event_judge_roster(target_event uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare event_org uuid; result jsonb;
begin
  if auth.uid() is null or not public.can_manage_event(target_event) then
    raise exception 'not authorized to manage this event';
  end if;
  select organization_id into event_org from public.events where id = target_event;
  if event_org is null then raise exception 'event not found'; end if;
  select jsonb_build_object(
    'profiles', coalesce((select jsonb_agg(jsonb_build_object('id',membership.user_id,
      'full_name',coalesce(nullif(trim(profile.full_name),''),'Juiz sem nome')) order by profile.full_name, membership.user_id)
      from public.user_roles membership join public.profiles profile on profile.id = membership.user_id
      where membership.organization_id = event_org and membership.role = 'judge'),'[]'::jsonb),
    'assignments', coalesce((select jsonb_agg(jsonb_build_object('id',ja.id,'judge_id',ja.judge_id,
      'competition_id',ja.competition_id,'category_id',ja.category_id,'ring_id',ja.ring_id,'active',ja.active,
      'profiles',jsonb_build_object('full_name',coalesce(nullif(trim(profile.full_name),''),'Juiz sem nome')),
      'competitions',jsonb_build_object('name',competition.name),
      'categories',case when category.id is null then null else jsonb_build_object('name',category.name) end,
      'rings',case when ring.id is null then null else jsonb_build_object('name',ring.name) end)
      order by ja.active desc, profile.full_name, competition.name, category.name)
      from public.judge_assignments ja join public.profiles profile on profile.id = ja.judge_id
      join public.competitions competition on competition.id = ja.competition_id
      left join public.categories category on category.id = ja.category_id
      left join public.rings ring on ring.id = ja.ring_id where ja.event_id = target_event),'[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.event_judge_roster(uuid) from public, anon, authenticated;
grant execute on function public.event_judge_roster(uuid) to authenticated;

-- Telões deixam de exibir resultados automaticamente quando o evento termina.
create or replace function public.close_finished_event_displays() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('finished','archived') and old.status is distinct from new.status then
    update public.display_sessions set active = false where event_id = new.id and active;
  end if;
  return new;
end;
$$;
drop trigger if exists close_finished_event_displays on public.events;
create trigger close_finished_event_displays after update of status on public.events
for each row execute function public.close_finished_event_displays();

create or replace function public.prevent_closed_event_display_activation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.active and exists(select 1 from public.events e where e.id = new.event_id and e.status in ('finished','archived')) then
    raise exception 'cannot activate a display for a finished event';
  end if;
  return new;
end;
$$;
drop trigger if exists prevent_closed_event_display_activation on public.display_sessions;
create trigger prevent_closed_event_display_activation before insert or update of active,event_id on public.display_sessions
for each row execute function public.prevent_closed_event_display_activation();
revoke all on function public.close_finished_event_displays() from public, anon, authenticated;
revoke all on function public.prevent_closed_event_display_activation() from public, anon, authenticated;

-- Encerra sessões de telão de eventos que já haviam sido finalizados.
update public.display_sessions ds set active = false from public.events e
where e.id = ds.event_id and e.status in ('finished','archived') and ds.active;
notify pgrst, 'reload schema';

-- Acrescenta ao registro imutável os valores informados manualmente antes do encerramento.
-- Os relatórios já salvos não são alterados.

create or replace function public.finalize_event_and_snapshot(target_event uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ev public.events%rowtype; snap jsonb; saved_at timestamptz; lock_id uuid;
begin
  if auth.uid() is null or not public.can_manage_event(target_event) then raise exception 'not authorized to finish event'; end if;
  select * into ev from public.events where id=target_event for update;
  if not found then raise exception 'event not found'; end if;
  if exists(select 1 from public.event_closure_reports r where r.event_id=target_event) then
    raise exception 'event already has a closure report';
  end if;
  for lock_id in select r.id from public.rings r where r.event_id=target_event order by r.id loop
    perform pg_advisory_xact_lock(hashtext(lock_id::text));
  end loop;
  for lock_id in select c.id from public.categories c join public.competitions cp on cp.id=c.competition_id
    where cp.event_id=target_event order by c.id loop
    perform pg_advisory_xact_lock(hashtext(lock_id::text));
  end loop;
  perform 1 from public.results res join public.categories c on c.id=res.category_id
    join public.competitions cp on cp.id=c.competition_id where cp.event_id=target_event for update of res;
  perform 1 from public.presentations p join public.categories c on c.id=p.category_id
    join public.competitions cp on cp.id=c.competition_id where cp.event_id=target_event for update of p;
  perform 1 from public.matches m join public.categories c on c.id=m.category_id
    join public.competitions cp on cp.id=c.competition_id where cp.event_id=target_event for update of m;
  if exists(select 1 from public.presentations p join public.categories c on c.id=p.category_id
    join public.competitions cp on cp.id=c.competition_id where cp.event_id=target_event and p.status <> 'finished')
    or exists(select 1 from public.matches m join public.categories c on c.id=m.category_id
    join public.competitions cp on cp.id=c.competition_id where cp.event_id=target_event and m.status <> 'finished') then
    raise exception 'finish or resolve all presentations and matches before closing the event';
  end if;
  saved_at := clock_timestamp();
  select jsonb_build_object(
    'event', jsonb_build_object('id',ev.id,'name',ev.name,'edition',ev.edition,'starts_at',ev.starts_at,'venue',ev.venue,'city',ev.city,'closed_at',saved_at,
      'requires_payment',coalesce(ev.settings ->> 'require_payment','false') = 'true',
      'financial',coalesce(ev.settings -> 'financial_report','{}'::jsonb)),
    'form_fields', coalesce((select f.fields from public.public_registration_forms f where f.event_id=target_event),'[]'::jsonb),
    'registrations', coalesce((select jsonb_agg(jsonb_build_object('name',person.full_name,'category',cat.name,
      'competition',cp.name,'age',r.data ->> 'age','song',r.data ->> 'song_title','author',r.data ->> 'song_author',
      'additional_data',r.data,
      'attendance_confirmed',r.attendance_confirmed,'payment_confirmed',r.payment_confirmed) order by cp.name,cat.name,person.full_name)
      from public.registrations r join public.participants person on person.id=r.participant_id
      join public.categories cat on cat.id=r.category_id join public.competitions cp on cp.id=cat.competition_id
      where r.event_id=target_event),'[]'::jsonb),
    'results', coalesce((select jsonb_agg(jsonb_build_object('competition',cp.name,'category',cat.name,'name',person.full_name,
      'position',res.position,'total',res.total,'published',res.published_at is not null) order by cp.name,cat.name,res.position)
      from public.results res join public.categories cat on cat.id=res.category_id join public.competitions cp on cp.id=cat.competition_id
      join public.registrations r on r.id=res.registration_id join public.participants person on person.id=r.participant_id
      where cp.event_id=target_event),'[]'::jsonb),
    'scorecards', coalesce((select jsonb_agg(jsonb_build_object('competition',cp.name,'category',cat.name,'name',person.full_name,
      'judge',judge.full_name,'note',card.note,'average',public.scorecard_normalized_average(card.id),
      'admin_edit_reason',card.admin_edit_reason,'admin_edited_at',card.admin_edited_at,
      'criteria',coalesce((select jsonb_agg(jsonb_build_object('name',criterion.name,'score',item.score,'minimum',criterion.min_score,'maximum',criterion.max_score) order by criterion.sort_order)
        from public.score_items item join public.scoring_criteria criterion on criterion.id=item.criterion_id where item.scorecard_id=card.id),'[]'::jsonb))
      order by cp.name,cat.name,person.full_name,judge.full_name)
      from public.scorecards card join public.presentations p on p.id=card.presentation_id join public.categories cat on cat.id=p.category_id
      join public.competitions cp on cp.id=cat.competition_id join public.registrations r on r.id=p.registration_id
      join public.participants person on person.id=r.participant_id join public.profiles judge on judge.id=card.judge_id
      where cp.event_id=target_event),'[]'::jsonb),
    'matches', coalesce((select jsonb_agg(jsonb_build_object('competition',cp.name,'category',cat.name,'phase',m.phase,
      'blue',blue.full_name,'green',green.full_name,'winner',winner.full_name,
      'votes',coalesce((select jsonb_agg(jsonb_build_object('judge',judge.full_name,'color',v.color) order by judge.full_name)
        from public.flag_votes v join public.profiles judge on judge.id=v.judge_id where v.match_id=m.id),'[]'::jsonb))
      order by cp.name,cat.name,m.phase)
      from public.matches m join public.categories cat on cat.id=m.category_id join public.competitions cp on cp.id=cat.competition_id
      join public.registrations rb on rb.id=m.blue_registration_id join public.participants blue on blue.id=rb.participant_id
      join public.registrations rg on rg.id=m.green_registration_id join public.participants green on green.id=rg.participant_id
      left join public.registrations rw on rw.id=m.winner_registration_id left join public.participants winner on winner.id=rw.participant_id
      where cp.event_id=target_event),'[]'::jsonb)
  ) into snap;
  insert into public.event_closure_reports(event_id,snapshot,closed_at,closed_by) values(target_event,snap,saved_at,auth.uid());
  perform set_config('app.event_closure','true',true);
  update public.events set status='finished' where id=target_event;
  insert into public.audit_logs(actor_id,event_id,action,entity_type,entity_id,details)
  values(auth.uid(),target_event,'event_closed_with_report','event',target_event,jsonb_build_object('closed_at',saved_at));
  return jsonb_build_object('closed_at',saved_at);
end;
$$;

notify pgrst, 'reload schema';

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

-- Executar apenas em transação revertida com ROLLBACK.
do $$
declare actor uuid; org uuid; event_id uuid := gen_random_uuid(); snapshot jsonb;
begin
  select user_id, organization_id into actor, org from public.user_roles where role='admin' limit 1;
  if actor is null then raise exception 'teste requer administrador existente'; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claims',json_build_object('sub',actor::text,'role','authenticated')::text,true);
  insert into public.events(id,organization_id,name,slug,status,created_by,settings)
  values(event_id,org,'Teste financeiro temporário','teste-financeiro-'||event_id::text,'preparing',actor,
    '{"require_payment":false,"financial_report":{"income_cents":1550,"expenses_cents":200,"notes":"Anotação de teste"}}'::jsonb);
  perform public.finalize_event_and_snapshot(event_id);
  snapshot := public.get_event_closure_report(event_id) -> 'snapshot';
  if snapshot -> 'event' -> 'financial' ->> 'income_cents' <> '1550'
     or snapshot -> 'event' -> 'financial' ->> 'expenses_cents' <> '200'
     or snapshot -> 'event' -> 'financial' ->> 'notes' <> 'Anotação de teste' then
    raise exception 'valores financeiros não foram preservados';
  end if;
  if snapshot -> 'event' ->> 'requires_payment' <> 'false' then raise exception 'pagamento opcional alterado'; end if;
end;
$$;

rollback;
