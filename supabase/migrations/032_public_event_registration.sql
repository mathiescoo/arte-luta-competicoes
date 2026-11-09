-- Configuração de inscrições públicas e envio atômico para um evento.
create table if not exists public.public_registration_forms (
  event_id uuid primary key references public.events(id) on delete cascade,
  public_token uuid not null unique default gen_random_uuid(),
  enabled boolean not null default false,
  fields jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);
alter table public.public_registration_forms enable row level security;
revoke all on public.public_registration_forms from public, anon, authenticated;

create or replace function public.registration_song_key(song text)
returns text language sql immutable set search_path = public as $$
  select regexp_replace(lower(translate(coalesce(song,''),
    'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç',
    'AAAAAEEEEIIIIOOOOOUUUUCAAAAAEEEEIIIIOOOOOUUUUC')), '[^[:alnum:]]+', '', 'g');
$$;
revoke all on function public.registration_song_key(text) from public, anon, authenticated;

create or replace function public.manage_public_registration_form(target_event uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  if auth.uid() is null or not public.can_manage_event(target_event) then raise exception 'not authorized to configure registration'; end if;
  select jsonb_build_object('token', f.public_token, 'enabled', f.enabled, 'fields', f.fields)
  into result from public.public_registration_forms f where f.event_id=target_event;
  return coalesce(result, jsonb_build_object('token', null, 'enabled', false, 'fields', '[]'::jsonb));
end;
$$;

create or replace function public.save_public_registration_form(
  target_event uuid, is_enabled boolean, custom_fields jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare item jsonb; option_value jsonb; keys text[] := array[]::text[]; key_name text; token uuid;
begin
  if auth.uid() is null or not public.can_manage_event(target_event) then
    raise exception 'not authorized to configure registration';
  end if;
  if jsonb_typeof(custom_fields) is distinct from 'array' or jsonb_array_length(custom_fields) > 20 then
    raise exception 'configure at most 20 custom fields';
  end if;
  for item in select value from jsonb_array_elements(custom_fields) loop
    key_name := item ->> 'key';
    if key_name is null or key_name !~ '^[a-z][a-z0-9_]{0,39}$' or key_name = any(keys)
      or key_name in ('full_name','age','song_title','song_author') then
      raise exception 'invalid or repeated custom field key';
    end if;
    if coalesce(length(trim(item ->> 'label')), 0) not between 1 and 100
      or coalesce(item ->> 'type', '') not in ('text','number','date','select')
      or jsonb_typeof(item -> 'required') is distinct from 'boolean' then
      raise exception 'invalid custom field definition';
    end if;
    if item ->> 'type' = 'select' and (jsonb_typeof(item -> 'options') is distinct from 'array'
      or jsonb_array_length(item -> 'options') not between 1 and 30) then
      raise exception 'select fields need between 1 and 30 options';
    end if;
    if item ->> 'type' = 'select' then
      for option_value in select value from jsonb_array_elements(item -> 'options') loop
        if jsonb_typeof(option_value) <> 'string' or length(trim(option_value #>> '{}')) not between 1 and 100 then
          raise exception 'invalid select option';
        end if;
      end loop;
    end if;
    keys := array_append(keys, key_name);
  end loop;
  insert into public.public_registration_forms(event_id, enabled, fields, updated_by)
  values (target_event, coalesce(is_enabled,false), custom_fields, auth.uid())
  on conflict(event_id) do update set enabled=excluded.enabled, fields=excluded.fields,
    updated_at=now(), updated_by=auth.uid()
  returning public_token into token;
  insert into public.audit_logs(actor_id,event_id,action,entity_type,entity_id,details)
  values(auth.uid(),target_event,'public_registration_form_updated','event',target_event,
    jsonb_build_object('enabled',coalesce(is_enabled,false),'field_count',jsonb_array_length(custom_fields)));
  return jsonb_build_object('token', token, 'enabled', coalesce(is_enabled,false));
end;
$$;

create or replace function public.public_registration_form(form_token uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  select jsonb_build_object(
    'event', jsonb_build_object('name', e.name, 'starts_at', e.starts_at, 'venue', e.venue, 'city', e.city),
    'fields', f.fields,
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name,
      'competition', cp.name, 'model', cp.model) order by cp.name, c.sort_order, c.name)
      from public.competitions cp join public.categories c on c.competition_id=cp.id
      where cp.event_id=e.id), '[]'::jsonb),
    'taken_songs', coalesce((select jsonb_agg(distinct trim(r.data ->> 'song_title'))
      from public.registrations r join public.categories c on c.id=r.category_id
      join public.competitions cp on cp.id=c.competition_id
      where r.event_id=e.id and cp.model='sum_score' and nullif(trim(r.data ->> 'song_title'),'') is not null), '[]'::jsonb)
  ) into result from public.public_registration_forms f join public.events e on e.id=f.event_id
  where f.public_token=form_token and f.enabled and e.status='registration_open';
  return result;
end;
$$;

create or replace function public.submit_public_registration(
  form_token uuid, target_category uuid, participant_name text, supplied_data jsonb
) returns void language plpgsql security definer set search_path = public as $$
declare f record; selected_model public.competition_model; item jsonb; val text;
  song text; normalized_song text; participant_id uuid; custom_key text;
  clean_data jsonb := '{}'::jsonb; age_text text;
begin
  if jsonb_typeof(supplied_data) is distinct from 'object' or octet_length(supplied_data::text) > 12000
    or char_length(trim(coalesce(participant_name,''))) not between 2 and 150 then
    raise exception 'invalid registration data';
  end if;
  select form.event_id, form.fields, e.organization_id into f
  from public.public_registration_forms form join public.events e on e.id=form.event_id
  where form.public_token=form_token and form.enabled and e.status='registration_open'
  for update of form, e;
  if not found then raise exception 'registration is not open'; end if;
  select cp.model into selected_model from public.categories c
  join public.competitions cp on cp.id=c.competition_id
  where c.id=target_category and cp.event_id=f.event_id;
  if not found then raise exception 'invalid category'; end if;
  age_text := trim(coalesce(supplied_data ->> 'age',''));
  if age_text !~ '^[0-9]{1,3}$' or age_text::integer > 130 then raise exception 'invalid age'; end if;
  clean_data := jsonb_build_object('age', age_text, '_labels', '{}'::jsonb);
  for item in select value from jsonb_array_elements(f.fields) loop
    custom_key := item ->> 'key';
    val := nullif(trim(supplied_data ->> custom_key),'');
    if (item ->> 'required')::boolean and val is null then raise exception 'a required field is missing'; end if;
    if char_length(coalesce(val,'')) > 500 then raise exception 'field value too long'; end if;
    if val is not null and item ->> 'type'='select' and not (item -> 'options' ? val) then
      raise exception 'invalid option';
    end if;
    if val is not null and item ->> 'type'='number' and val !~ '^[0-9]+([.,][0-9]+)?$' then raise exception 'invalid number'; end if;
    if val is not null and item ->> 'type'='date' then perform val::date; end if;
    if val is not null then
      clean_data := clean_data || jsonb_build_object(custom_key, val);
      clean_data := jsonb_set(clean_data, array['_labels',custom_key], to_jsonb(item ->> 'label'), true);
    end if;
  end loop;
  if selected_model='sum_score' then
    song := nullif(trim(supplied_data ->> 'song_title'),'');
    if song is null or char_length(song)>250 or nullif(trim(supplied_data ->> 'song_author'),'') is null
      or char_length(trim(supplied_data ->> 'song_author'))>250 then raise exception 'song and author are required'; end if;
    normalized_song := public.registration_song_key(song);
    if normalized_song = '' then raise exception 'invalid song'; end if;
    if exists(select 1 from public.registrations r join public.categories c on c.id=r.category_id
      join public.competitions cp on cp.id=c.competition_id where r.event_id=f.event_id and cp.model='sum_score'
      and public.registration_song_key(r.data ->> 'song_title')=normalized_song) then
      raise exception 'song already selected';
    end if;
    clean_data := clean_data || jsonb_build_object('song_title', song, 'song_author', trim(supplied_data ->> 'song_author'));
  end if;
  insert into public.participants(organization_id, full_name) values(f.organization_id, trim(participant_name)) returning id into participant_id;
  insert into public.registrations(event_id, participant_id, category_id, data)
  values(f.event_id, participant_id, target_category, clean_data);
  insert into public.audit_logs(actor_id,event_id,action,entity_type,entity_id,details)
  values(auth.uid(),f.event_id,'public_registration_submitted','participant',participant_id,
    jsonb_build_object('category_id',target_category));
end;
$$;

revoke all on function public.save_public_registration_form(uuid,boolean,jsonb) from public, anon, authenticated;
revoke all on function public.manage_public_registration_form(uuid) from public, anon, authenticated;
revoke all on function public.public_registration_form(uuid) from public, anon, authenticated;
revoke all on function public.submit_public_registration(uuid,uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.save_public_registration_form(uuid,boolean,jsonb) to authenticated;
grant execute on function public.manage_public_registration_form(uuid) to authenticated;
grant execute on function public.public_registration_form(uuid) to anon, authenticated;
grant execute on function public.submit_public_registration(uuid,uuid,text,jsonb) to anon, authenticated;
notify pgrst, 'reload schema';
