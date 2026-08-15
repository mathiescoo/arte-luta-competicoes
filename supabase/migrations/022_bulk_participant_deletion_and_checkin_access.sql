-- Allows a manager to remove a selected group atomically. If one selected
-- registration is protected by scores, results, or a match, the whole batch
-- is rolled back instead of leaving a partial deletion.
create or replace function public.delete_event_registrations(target_registrations uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  registration_ids uuid[];
  registration_id uuid;
  deletion_result jsonb;
  deleted_count integer := 0;
  deleted_participant_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if coalesce(array_length(target_registrations, 1), 0) = 0 then
    raise exception 'select at least one registration';
  end if;

  select coalesce(array_agg(distinct candidate.id order by candidate.id), array[]::uuid[])
  into registration_ids
  from unnest(target_registrations) as candidate(id);

  if cardinality(registration_ids) = 0 then
    raise exception 'select at least one registration';
  end if;
  if (
    select count(*)
    from public.registrations registration
    where registration.id = any(registration_ids)
  ) <> cardinality(registration_ids) then
    raise exception 'one or more selected registrations were not found';
  end if;
  if (
    select count(distinct registration.event_id)
    from public.registrations registration
    where registration.id = any(registration_ids)
  ) <> 1 then
    raise exception 'all selected registrations must belong to one event';
  end if;

  foreach registration_id in array registration_ids
  loop
    deletion_result := public.delete_event_registration(registration_id);
    deleted_count := deleted_count + 1;
    if coalesce((deletion_result ->> 'participant_deleted')::boolean, false) then
      deleted_participant_count := deleted_participant_count + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'registration_count', deleted_count,
    'participant_count', deleted_participant_count
  );
end;
$$;

revoke all on function public.delete_event_registrations(uuid[]) from public;
grant execute on function public.delete_event_registrations(uuid[]) to authenticated;

-- An organizer assigned to one event may read only participants who are
-- registered in that event, which keeps the check-in relationship visible.
drop policy if exists "event managers read event participants" on public.participants;
create policy "event managers read event participants" on public.participants
for select
using (
  exists (
    select 1
    from public.registrations registration
    where registration.participant_id = participants.id
      and public.can_manage_event(registration.event_id)
  )
);

notify pgrst, 'reload schema';
