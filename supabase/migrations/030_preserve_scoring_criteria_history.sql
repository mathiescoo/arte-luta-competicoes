-- Keep each scorecard attached to its original criteria. Retired criteria
-- remain in the database solely for historical scorecards.
alter table public.scoring_criteria
  add column if not exists active boolean not null default true;

create or replace function public.replace_scoring_criteria_preserving_history(
  target_competition uuid,
  criteria jsonb,
  change_reason text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  target_event uuid;
  target_model public.competition_model;
  item record;
  criterion_name text;
  minimum numeric;
  maximum numeric;
  names text[] := array[]::text[];
  category_lock uuid;
  normalized_reason text := nullif(trim(coalesce(change_reason, '')), '');
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select cp.event_id, cp.model into target_event, target_model
  from public.competitions cp where cp.id = target_competition;
  if target_event is null or not public.can_manage_event(target_event) then
    raise exception 'not authorized to configure scoring criteria';
  end if;
  if target_model <> 'sum_score'::public.competition_model then
    raise exception 'criteria can only be configured for scoring competitions';
  end if;
  if normalized_reason is null or char_length(normalized_reason) not between 3 and 500 then
    raise exception 'a reason between 3 and 500 characters is required';
  end if;
  if criteria is null or jsonb_typeof(criteria) <> 'array'
     or jsonb_array_length(criteria) not between 1 and 12 then
    raise exception 'configure between 1 and 12 scoring criteria';
  end if;

  -- Matches the category locks used when opening, finishing or resetting a
  -- presentation. Do not change criteria halfway through a performance.
  for category_lock in select c.id from public.categories c
    where c.competition_id = target_competition order by c.id
  loop
    perform pg_advisory_xact_lock(hashtext(category_lock::text));
  end loop;
  if exists (select 1 from public.presentations p
    join public.categories c on c.id = p.category_id
    where c.competition_id = target_competition and p.status = 'live') then
    raise exception 'finish the open presentation before changing criteria';
  end if;

  for item in select value, ordinality from jsonb_array_elements(criteria) with ordinality loop
    criterion_name := nullif(trim(item.value ->> 'name'), '');
    begin
      minimum := coalesce(nullif(trim(item.value ->> 'min_score'), '')::numeric, 0);
      maximum := coalesce(nullif(trim(item.value ->> 'max_score'), '')::numeric, 10);
    exception when invalid_text_representation then
      raise exception 'criterion scores must be numeric';
    end;
    if criterion_name is null or char_length(criterion_name) > 80 then
      raise exception 'each criterion needs a name with up to 80 characters';
    end if;
    if lower(criterion_name) = any(names) then raise exception 'criterion names cannot be duplicated'; end if;
    if minimum < 0 or maximum > 10 or minimum >= maximum then
      raise exception 'criterion ranges must be between 0 and 10';
    end if;
    names := array_append(names, lower(criterion_name));
  end loop;

  update public.scoring_criteria set active = false
  where competition_id = target_competition and active;
  for item in select value, ordinality from jsonb_array_elements(criteria) with ordinality loop
    insert into public.scoring_criteria(competition_id, name, description, min_score, max_score, sort_order, active)
    values (target_competition, trim(item.value ->> 'name'),
      nullif(trim(item.value ->> 'description'), ''),
      coalesce(nullif(trim(item.value ->> 'min_score'), '')::numeric, 0),
      coalesce(nullif(trim(item.value ->> 'max_score'), '')::numeric, 10),
      item.ordinality::integer - 1, true);
  end loop;

  insert into public.audit_logs(actor_id, event_id, action, entity_type, entity_id, details)
  values (auth.uid(), target_event, 'scoring_criteria_changed_preserving_history',
    'competition', target_competition, jsonb_build_object('reason', normalized_reason, 'criteria', criteria));
end;
$$;

-- Prevent an older browser tab from invoking the former destructive reset.
create or replace function public.replace_scoring_criteria_and_reset(
  target_competition uuid, criteria jsonb, reset_reason text, confirmed boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  raise exception 'refresh the page to change criteria while preserving existing scorecards';
end;
$$;

create or replace function public.replace_scoring_criteria(target_competition uuid, criteria jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  raise exception 'refresh the page to change criteria while preserving existing scorecards';
end;
$$;

revoke all on function public.replace_scoring_criteria_preserving_history(uuid, jsonb, text) from public;
grant execute on function public.replace_scoring_criteria_preserving_history(uuid, jsonb, text) to authenticated;
