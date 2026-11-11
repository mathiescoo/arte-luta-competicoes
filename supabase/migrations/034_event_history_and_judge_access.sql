-- Preserve histórico de eventos fechados e permite retirar o acesso de juízes.
-- Não apaga pessoas, fichas, votos ou designações históricas.
begin;

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
commit;
