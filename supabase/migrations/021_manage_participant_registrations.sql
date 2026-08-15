-- Gestão segura de inscrições: trocar a categoria antes da avaliação ou
-- excluir a inscrição sem deixar apresentações, confrontos ou resultados órfãos.

create or replace function public.reassign_registration_category(
  target_registration uuid,
  target_category uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_event uuid;
  current_category uuid;
  target_participant uuid;
  target_organization uuid;
  participant_organization uuid;
  current_competition uuid;
  destination_event uuid;
  destination_competition uuid;
  next_position integer;
  moved_presentation boolean := false;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select registration.event_id, registration.category_id, registration.participant_id
  into target_event, current_category, target_participant
  from public.registrations registration
  where registration.id = target_registration
  for update;

  if target_event is null then
    raise exception 'registration not found';
  end if;
  if not public.can_manage_event(target_event) then
    raise exception 'not authorized to manage this registration';
  end if;

  select event.organization_id
  into target_organization
  from public.events event
  where event.id = target_event;

  select participant.organization_id
  into participant_organization
  from public.participants participant
  where participant.id = target_participant
  for update;

  if participant_organization is distinct from target_organization then
    raise exception 'the participant does not belong to this event organization';
  end if;

  -- Lock any existing queue item before inspecting its status. This keeps a
  -- judge submission or a queue generation from racing this change.
  perform 1
  from public.presentations presentation
  where presentation.registration_id = target_registration
  for update;

  if current_category = target_category then
    return jsonb_build_object('registration_id', target_registration, 'category_id', current_category, 'presentation_moved', false);
  end if;

  select category.competition_id
  into current_competition
  from public.categories category
  where category.id = current_category;

  select competition.event_id, category.competition_id
  into destination_event, destination_competition
  from public.categories category
  join public.competitions competition on competition.id = category.competition_id
  where category.id = target_category;

  if destination_event is null or destination_event <> target_event then
    raise exception 'the destination category must belong to the same event';
  end if;
  if destination_competition <> current_competition then
    raise exception 'move the participant only between categories of the same competition';
  end if;
  if exists (
    select 1
    from public.registrations registration
    where registration.event_id = target_event
      and registration.participant_id = target_participant
      and registration.category_id = target_category
      and registration.id <> target_registration
  ) then
    raise exception 'this participant is already registered in the destination category';
  end if;
  if exists (
    select 1
    from public.results result
    where result.registration_id = target_registration
  ) then
    raise exception 'this registration already has a result and cannot be moved';
  end if;
  if exists (
    select 1
    from public.presentations presentation
    join public.scorecards scorecard on scorecard.presentation_id = presentation.id
    where presentation.registration_id = target_registration
  ) or exists (
    select 1
    from public.presentations presentation
    where presentation.registration_id = target_registration
      and presentation.status <> 'waiting'
  ) then
    raise exception 'this presentation already started or received scores and cannot be moved';
  end if;
  if exists (
    select 1
    from public.matches match
    where match.blue_registration_id = target_registration
      or match.green_registration_id = target_registration
      or match.winner_registration_id = target_registration
  ) then
    raise exception 'remove the participant from the match bracket before moving the category';
  end if;

  update public.registrations
  set category_id = target_category
  where id = target_registration;

  if exists (select 1 from public.presentations presentation where presentation.registration_id = target_registration) then
    select coalesce(max(presentation.sort_order), 0) + 1
    into next_position
    from public.presentations presentation
    where presentation.category_id = target_category;

    update public.presentations
    set category_id = target_category,
      sort_order = next_position
    where registration_id = target_registration;
    moved_presentation := true;
  end if;

  insert into public.audit_logs(actor_id, event_id, action, entity_type, entity_id, details)
  values (
    auth.uid(),
    target_event,
    'registration_category_reassigned',
    'registration',
    target_registration,
    jsonb_build_object(
      'from_category_id', current_category,
      'to_category_id', target_category,
      'presentation_moved', moved_presentation
    )
  );

  return jsonb_build_object(
    'registration_id', target_registration,
    'category_id', target_category,
    'presentation_moved', moved_presentation
  );
end;
$$;

create or replace function public.delete_event_registration(target_registration uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_event uuid;
  target_participant uuid;
  target_organization uuid;
  participant_organization uuid;
  participant_deleted boolean := false;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select registration.event_id, registration.participant_id
  into target_event, target_participant
  from public.registrations registration
  where registration.id = target_registration
  for update;

  if target_event is null then
    raise exception 'registration not found';
  end if;
  if not public.can_manage_event(target_event) then
    raise exception 'not authorized to manage this registration';
  end if;

  select event.organization_id
  into target_organization
  from public.events event
  where event.id = target_event;

  select participant.organization_id
  into participant_organization
  from public.participants participant
  where participant.id = target_participant
  for update;

  if participant_organization is distinct from target_organization then
    raise exception 'the participant does not belong to this event organization';
  end if;

  -- See the equivalent lock in the reassign function. A scorecard insert
  -- needs a foreign-key lock on this row and cannot slip in after this point.
  perform 1
  from public.presentations presentation
  where presentation.registration_id = target_registration
  for update;

  if exists (
    select 1
    from public.results result
    where result.registration_id = target_registration
  ) then
    raise exception 'this registration already has a result and cannot be deleted';
  end if;
  if exists (
    select 1
    from public.presentations presentation
    join public.scorecards scorecard on scorecard.presentation_id = presentation.id
    where presentation.registration_id = target_registration
  ) or exists (
    select 1
    from public.presentations presentation
    where presentation.registration_id = target_registration
      and presentation.status <> 'waiting'
  ) then
    raise exception 'this presentation already started or received scores and cannot be deleted';
  end if;
  if exists (
    select 1
    from public.matches match
    where match.blue_registration_id = target_registration
      or match.green_registration_id = target_registration
      or match.winner_registration_id = target_registration
  ) then
    raise exception 'remove the participant from the match bracket before deleting the registration';
  end if;

  delete from public.presentations presentation
  where presentation.registration_id = target_registration;

  delete from public.registrations registration
  where registration.id = target_registration;

  if not exists (
    select 1
    from public.registrations registration
    where registration.participant_id = target_participant
  ) then
    delete from public.participants participant
    where participant.id = target_participant;
    participant_deleted := true;
  end if;

  insert into public.audit_logs(actor_id, event_id, action, entity_type, entity_id, details)
  values (
    auth.uid(),
    target_event,
    'registration_deleted',
    'registration',
    target_registration,
    jsonb_build_object(
      'participant_id', target_participant,
      'participant_deleted', participant_deleted
    )
  );

  return jsonb_build_object(
    'registration_id', target_registration,
    'participant_deleted', participant_deleted
  );
end;
$$;

revoke all on function public.reassign_registration_category(uuid, uuid) from public;
revoke all on function public.delete_event_registration(uuid) from public;
grant execute on function public.reassign_registration_category(uuid, uuid) to authenticated;
grant execute on function public.delete_event_registration(uuid) to authenticated;

notify pgrst, 'reload schema';
