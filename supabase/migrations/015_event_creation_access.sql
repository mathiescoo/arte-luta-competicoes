-- Corrige a criação de eventos separando a autorização de criação das regras
-- de gestão de eventos já existentes e criando evento + competições em conjunto.

drop policy if exists "managers write events" on public.events;
drop policy if exists "admins create events" on public.events;
drop policy if exists "managers update events" on public.events;
drop policy if exists "managers delete events" on public.events;

create policy "admins create events" on public.events
for insert with check (public.is_admin(organization_id) and created_by = auth.uid());

create policy "managers update events" on public.events
for update
using (public.can_manage_event(id))
with check (public.can_manage_event(id));

create policy "managers delete events" on public.events
for delete using (public.can_manage_event(id));

create or replace function public.create_event_with_competitions(
  event_name text,
  event_edition text,
  event_starts_at timestamptz,
  event_city text,
  event_venue text,
  competition_templates text[]
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  organization_id uuid;
  created_event_id uuid;
  template_id text;
  competition_name text;
  competition_model public.competition_model;
  generated_slug text;
begin
  if actor_id is null then
    raise exception 'not authenticated';
  end if;

  select user_roles.organization_id into organization_id
  from public.user_roles
  where user_roles.user_id = actor_id and user_roles.role = 'admin'
  order by user_roles.organization_id
  limit 1;

  if organization_id is null then
    raise exception 'administrator access is required to create an event';
  end if;
  if nullif(trim(event_name), '') is null then
    raise exception 'event name is required';
  end if;
  if coalesce(array_length(competition_templates, 1), 0) = 0 then
    raise exception 'select at least one competition';
  end if;
  if cardinality(competition_templates) <> (
    select count(distinct item) from unnest(competition_templates) as requested(item)
  ) then
    raise exception 'competition templates cannot be duplicated';
  end if;
  if exists (
    select 1 from unnest(competition_templates) as requested(item)
    where item is null or item not in ('internal', 'mirim', 'musicality')
  ) then
    raise exception 'invalid competition template';
  end if;

  generated_slug := trim(both '-' from regexp_replace(lower(trim(event_name)), '[^a-z0-9]+', '-', 'g'));
  if generated_slug = '' then generated_slug := 'evento'; end if;
  generated_slug := generated_slug || '-' || substring(gen_random_uuid()::text from 1 for 8);

  insert into public.events (
    organization_id, name, slug, edition, starts_at, city, venue, status, created_by, settings
  ) values (
    organization_id,
    trim(event_name),
    generated_slug,
    nullif(trim(event_edition), ''),
    event_starts_at,
    nullif(trim(event_city), ''),
    nullif(trim(event_venue), ''),
    'draft',
    actor_id,
    jsonb_build_object('competition_selection', to_jsonb(competition_templates))
  ) returning id into created_event_id;

  foreach template_id in array competition_templates loop
    case template_id
      when 'internal' then
        competition_name := 'Campeonato Interno';
        competition_model := 'digital_flags';
      when 'mirim' then
        competition_name := 'Festival Mirim';
        competition_model := 'digital_flags';
      when 'musicality' then
        competition_name := 'Cante Comigo Capoeira Intérpretes';
        competition_model := 'sum_score';
      else
        raise exception 'invalid competition template: %', template_id;
    end case;

    insert into public.competitions(event_id, name, model, status, settings)
    values (created_event_id, competition_name, competition_model, 'draft', jsonb_build_object('template', template_id));
  end loop;

  return created_event_id;
end;
$$;

revoke all on function public.create_event_with_competitions(text, text, timestamptz, text, text, text[]) from public;
grant execute on function public.create_event_with_competitions(text, text, timestamptz, text, text, text[]) to authenticated;
notify pgrst, 'reload schema';
