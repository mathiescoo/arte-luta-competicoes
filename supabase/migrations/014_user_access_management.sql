-- Administração de acessos sem expor usuários do auth.users ao navegador.
-- Execute esta migration no Supabase para tornar as mudanças de permissões atômicas.

drop policy if exists "admins manage organization roles" on public.user_roles;
create policy "admins read organization roles" on public.user_roles
for select using (public.is_admin(organization_id));

create or replace function public.manage_organization_access(
  target_user uuid,
  target_organization uuid,
  target_role public.app_role,
  enabled boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  admin_total integer;
begin
  if actor_id is null or not public.is_admin(target_organization) then
    raise exception 'not authorized to manage this organization';
  end if;

  if target_role = 'admin' and not enabled then
    select count(*) into admin_total
    from public.user_roles
    where organization_id = target_organization and role = 'admin';

    if target_user = actor_id then
      raise exception 'you cannot remove your own administrator access';
    end if;
    if admin_total <= 1 then
      raise exception 'the organization must keep at least one administrator';
    end if;
  end if;

  if target_role = 'admin' and enabled and not exists (
    select 1 from public.user_roles
    where organization_id = target_organization and user_id = target_user
  ) then
    raise exception 'the user must already belong to the organization before becoming administrator';
  end if;

  if enabled then
    insert into public.user_roles(user_id, organization_id, role)
    values (target_user, target_organization, target_role)
    on conflict do nothing;
  else
    delete from public.user_roles
    where user_id = target_user
      and organization_id = target_organization
      and role = target_role;

    if target_role = 'judge' then
      update public.judge_assignments
      set active = false
      where judge_id = target_user
        and exists (
          select 1 from public.events
          where events.id = judge_assignments.event_id
            and events.organization_id = target_organization
        );
    end if;
  end if;

  if target_role = 'judge' and enabled then
    update public.judge_applications
    set status = 'approved', reviewed_at = now()
    where user_id = target_user
      and organization_id = target_organization
      and status = 'pending';
  end if;
end;
$$;

create or replace function public.review_judge_application(
  target_application uuid,
  approved boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  application_org uuid;
  applicant_id uuid;
begin
  select organization_id, user_id
  into application_org, applicant_id
  from public.judge_applications
  where id = target_application
  for update;

  if application_org is null then
    raise exception 'judge application not found';
  end if;
  if auth.uid() is null or not public.is_admin(application_org) then
    raise exception 'not authorized to review this application';
  end if;

  if approved then
    insert into public.user_roles(user_id, organization_id, role)
    values (applicant_id, application_org, 'judge')
    on conflict do nothing;
  end if;

  update public.judge_applications
  set status = case when approved then 'approved' else 'rejected' end,
      reviewed_at = now()
  where id = target_application;
end;
$$;

revoke all on function public.manage_organization_access(uuid, uuid, public.app_role, boolean) from public;
revoke all on function public.review_judge_application(uuid, boolean) from public;
grant execute on function public.manage_organization_access(uuid, uuid, public.app_role, boolean) to authenticated;
grant execute on function public.review_judge_application(uuid, boolean) to authenticated;
