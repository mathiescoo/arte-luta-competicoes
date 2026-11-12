-- Aprovação de juiz já vinculada a um evento e remoção administrativa do acesso.
begin;

create or replace function public.admin_assign_judge_to_event(
  target_application uuid,
  target_event uuid,
  target_competition uuid,
  target_category uuid,
  target_ring uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  actor_id uuid := auth.uid();
  applicant_id uuid;
  application_org uuid;
  event_org uuid;
  competition_model public.competition_model;
  existing_assignment uuid;
begin
  select application.user_id, application.organization_id
  into applicant_id, application_org
  from public.judge_applications application
  where application.id = target_application
  for update;
  if applicant_id is null then raise exception 'judge application not found'; end if;
  if actor_id is null or not public.is_admin(application_org) then
    raise exception 'only an administrator can authorize and assign a judge';
  end if;

  select event.organization_id into event_org
  from public.events event
  where event.id = target_event and event.status not in ('finished', 'archived')
    and not exists(select 1 from public.event_closure_reports report where report.event_id = event.id);
  if event_org is null or event_org <> application_org then raise exception 'choose an open event in this organization'; end if;

  select competition.model into competition_model
  from public.competitions competition
  where competition.id = target_competition and competition.event_id = target_event;
  if competition_model is null then raise exception 'competition does not belong to the selected event'; end if;
  if not exists(select 1 from public.categories category where category.id = target_category and category.competition_id = target_competition) then
    raise exception 'category does not belong to the selected competition';
  end if;
  if competition_model = 'digital_flags' and target_ring is null then raise exception 'select a ring for a flags competition'; end if;
  if target_ring is not null and not exists(select 1 from public.rings ring where ring.id = target_ring and ring.event_id = target_event) then
    raise exception 'ring does not belong to the selected event';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_event::text || applicant_id::text || target_competition::text || target_category::text || coalesce(target_ring::text, '')));
  insert into public.user_roles(user_id, organization_id, role)
  values(applicant_id, application_org, 'judge') on conflict do nothing;
  insert into public.event_users(event_id, user_id, role)
  values(target_event, applicant_id, 'judge') on conflict do nothing;

  select assignment.id into existing_assignment
  from public.judge_assignments assignment
  where assignment.event_id = target_event and assignment.judge_id = applicant_id
    and assignment.competition_id = target_competition
    and assignment.category_id = target_category
    and assignment.ring_id is not distinct from target_ring
    and assignment.active
  limit 1;
  if existing_assignment is null then
    insert into public.judge_assignments(event_id, competition_id, category_id, ring_id, judge_id, active, starts_at)
    values(target_event, target_competition, target_category, target_ring, applicant_id, true, clock_timestamp())
    returning id into existing_assignment;
  end if;

  update public.judge_applications
  set status = 'approved', reviewed_at = clock_timestamp()
  where id = target_application;
  insert into public.audit_logs(actor_id, event_id, action, entity_type, entity_id, details)
  values(actor_id, target_event, 'judge_authorized_and_assigned', 'user', applicant_id,
    jsonb_build_object('competition_id', target_competition, 'category_id', target_category, 'ring_id', target_ring));
  return jsonb_build_object('event_id', target_event, 'judge_id', applicant_id, 'assignment_id', existing_assignment);
end;
$$;

create or replace function public.remove_judge_from_organization(
  target_user uuid,
  target_organization uuid
) returns void
language plpgsql security definer set search_path = public as $$
declare actor_id uuid := auth.uid();
begin
  if actor_id is null or not public.is_admin(target_organization) then
    raise exception 'only an administrator can remove judge access';
  end if;

  -- A locked category can refuse this change; in that case all operations roll back.
  update public.judge_assignments assignment
  set active = false, ends_at = coalesce(assignment.ends_at, clock_timestamp())
  where assignment.judge_id = target_user and assignment.active
    and exists(select 1 from public.events event where event.id = assignment.event_id
      and event.organization_id = target_organization and event.status not in ('finished', 'archived')
      and not exists(select 1 from public.event_closure_reports report where report.event_id = event.id));

  delete from public.event_users membership
  using public.events event
  where membership.event_id = event.id and membership.user_id = target_user
    and membership.role = 'judge' and event.organization_id = target_organization;
  delete from public.user_roles
  where user_id = target_user and organization_id = target_organization and role = 'judge';
  delete from public.judge_applications
  where user_id = target_user and organization_id = target_organization;

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values(actor_id, 'judge_access_and_request_removed', 'user_role', target_user,
    jsonb_build_object('organization_id', target_organization, 'role', 'judge'));
end;
$$;

revoke all on function public.admin_assign_judge_to_event(uuid, uuid, uuid, uuid, uuid) from public, anon;
revoke all on function public.remove_judge_from_organization(uuid, uuid) from public, anon;
grant execute on function public.admin_assign_judge_to_event(uuid, uuid, uuid, uuid, uuid) to authenticated;
grant execute on function public.remove_judge_from_organization(uuid, uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
