-- Teste temporário: todos os dados de teste são desfeitos pelo ROLLBACK.
BEGIN;

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

-- Snapshot permanente do evento. O PDF é anexado depois da geração pelo servidor.
create table if not exists public.event_closure_reports (
  event_id uuid primary key references public.events(id) on delete restrict,
  snapshot jsonb not null,
  closed_at timestamptz not null default now(),
  closed_by uuid not null references public.profiles(id),
  pdf_base64 text,
  pdf_saved_at timestamptz
);
alter table public.event_closure_reports enable row level security;
revoke all on public.event_closure_reports from public, anon, authenticated;

-- These internal helpers are invoked by the security-definer report/display
-- functions, not directly by browsers. Supabase projects may grant EXECUTE
-- to anon explicitly through default privileges, so revoke that grant too.
revoke all on function public.scorecard_normalized_average(uuid) from public, anon, authenticated;
revoke all on function public.flag_match_judge_panels(uuid) from public, anon, authenticated;

create or replace function public.protect_event_closure_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'finished' and old.status <> 'finished'
     and coalesce(current_setting('app.event_closure', true),'') <> 'true' then
    raise exception 'use the event closure report to finish this event';
  end if;
  if old.status = 'finished' and new.status <> 'finished'
     and exists(select 1 from public.event_closure_reports r where r.event_id=old.id) then
    raise exception 'an event with a closure report cannot be reopened';
  end if;
  return new;
end;
$$;
drop trigger if exists protect_event_closure_status on public.events;
create trigger protect_event_closure_status before update on public.events
for each row execute function public.protect_event_closure_status();

-- Once a snapshot is saved, operational records for that event are read-only.
create or replace function public.protect_closed_event_records()
returns trigger language plpgsql security definer set search_path = public as $$
declare record_data jsonb; target_event uuid;
begin
  for record_data in select value from jsonb_array_elements(jsonb_build_array(to_jsonb(old),to_jsonb(new))) loop
    if jsonb_typeof(record_data) is distinct from 'object' then continue; end if;
    target_event := null;
    if tg_table_name in ('registrations','judge_assignments','competitions') then
      target_event := (record_data ->> 'event_id')::uuid;
    elsif tg_table_name in ('presentations','matches','results') then
      select cp.event_id into target_event from public.categories c join public.competitions cp on cp.id=c.competition_id
      where c.id=(record_data ->> 'category_id')::uuid;
    elsif tg_table_name in ('categories','scoring_criteria') then
      select cp.event_id into target_event from public.competitions cp where cp.id=(record_data ->> 'competition_id')::uuid;
    elsif tg_table_name='scorecards' then
      select cp.event_id into target_event from public.presentations p join public.categories c on c.id=p.category_id
      join public.competitions cp on cp.id=c.competition_id where p.id=(record_data ->> 'presentation_id')::uuid;
    elsif tg_table_name='flag_votes' then
      select cp.event_id into target_event from public.matches m join public.categories c on c.id=m.category_id
      join public.competitions cp on cp.id=c.competition_id where m.id=(record_data ->> 'match_id')::uuid;
    end if;
    if target_event is not null and exists(select 1 from public.event_closure_reports r where r.event_id=target_event) then
      raise exception 'closed event records cannot be changed';
    end if;
  end loop;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
do $$
declare table_name text;
begin
  foreach table_name in array array['registrations','judge_assignments','competitions','presentations','matches','results','categories','scoring_criteria','scorecards','flag_votes'] loop
    execute format('drop trigger if exists protect_closed_event_records on public.%I',table_name);
    execute format('create trigger protect_closed_event_records before insert or update or delete on public.%I for each row execute function public.protect_closed_event_records()',table_name);
  end loop;
end;
$$;

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
      'requires_payment',coalesce(ev.settings ->> 'require_payment','false') = 'true'),
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

create or replace function public.get_event_closure_report(target_event uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare report public.event_closure_reports%rowtype;
begin
  if auth.uid() is null or not public.can_manage_event(target_event) then raise exception 'not authorized to read report'; end if;
  select * into report from public.event_closure_reports where event_id=target_event;
  if not found then raise exception 'closure report not found'; end if;
  return jsonb_build_object('snapshot',report.snapshot,'pdf_base64',report.pdf_base64,'closed_at',report.closed_at);
end;
$$;

create or replace function public.event_closure_report_exists(target_event uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.can_manage_event(target_event) then raise exception 'not authorized to read report'; end if;
  return exists(select 1 from public.event_closure_reports r where r.event_id=target_event);
end;
$$;

create or replace function public.save_event_closure_pdf(target_event uuid, encoded_pdf text)
returns text language plpgsql security definer set search_path = public as $$
declare saved text;
begin
  if auth.uid() is null or not public.can_manage_event(target_event) then raise exception 'not authorized to save report'; end if;
  if encoded_pdf is null or char_length(encoded_pdf) > 15000000 or left(encoded_pdf,8) <> 'JVBERi0x' then raise exception 'invalid PDF'; end if;
  update public.event_closure_reports set pdf_base64=coalesce(pdf_base64,encoded_pdf),
    pdf_saved_at=coalesce(pdf_saved_at,clock_timestamp()) where event_id=target_event returning pdf_base64 into saved;
  if not found then raise exception 'closure report not found'; end if;
  return saved;
end;
$$;

revoke all on function public.protect_event_closure_status() from public, anon, authenticated;
revoke all on function public.protect_closed_event_records() from public, anon, authenticated;
revoke all on function public.finalize_event_and_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.get_event_closure_report(uuid) from public, anon, authenticated;
revoke all on function public.event_closure_report_exists(uuid) from public, anon, authenticated;
revoke all on function public.save_event_closure_pdf(uuid,text) from public, anon, authenticated;
grant execute on function public.finalize_event_and_snapshot(uuid) to authenticated;
grant execute on function public.get_event_closure_report(uuid) to authenticated;
grant execute on function public.event_closure_report_exists(uuid) to authenticated;
grant execute on function public.save_event_closure_pdf(uuid,text) to authenticated;
notify pgrst, 'reload schema';

-- Dados sintéticos: executar somente dentro de transação com ROLLBACK.
do $$
declare
  actor uuid; org uuid; event_id uuid := gen_random_uuid(); competition_id uuid := gen_random_uuid();
  category_id uuid := gen_random_uuid(); form_token uuid; payload jsonb; snapshot jsonb;
  repeated_blocked boolean := false; closed_blocked boolean := false; edit_blocked boolean := false;
begin
  select ur.user_id, ur.organization_id into actor, org from public.user_roles ur where ur.role='admin' limit 1;
  if actor is null then raise exception 'teste requer administrador existente'; end if;
  if has_table_privilege('anon','public.event_closure_reports','SELECT') then
    raise exception 'permissão indevida: relatório acessível pela tabela ao público';
  end if;
  if has_function_privilege('anon','public.get_event_closure_report(uuid)','EXECUTE') then
    raise exception 'permissão indevida: função de relatório acessível ao público';
  end if;
  if has_function_privilege('anon','public.scorecard_normalized_average(uuid)','EXECUTE') then
    raise exception 'permissão indevida: média interna acessível ao público';
  end if;
  if not has_function_privilege('anon','public.public_registration_form(uuid)','EXECUTE') then
    raise exception 'permissão ausente: público não consegue abrir formulário';
  end if;
  if not has_function_privilege('anon','public.submit_public_registration(uuid,uuid,text,jsonb)','EXECUTE') then
    raise exception 'permissão ausente: público não consegue enviar inscrição';
  end if;
  if not has_function_privilege('authenticated','public.get_event_closure_report(uuid)','EXECUTE') then
    raise exception 'permissão ausente: administrador não consegue ler relatório';
  end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claims',json_build_object('sub',actor::text,'role','authenticated')::text,true);
  insert into public.events(id,organization_id,name,slug,status,created_by)
  values(event_id,org,'Teste temporário de inscrição','teste-inscricao-'||event_id::text,'registration_open',actor);
  insert into public.competitions(id,event_id,name,model) values(competition_id,event_id,'Teste musical','sum_score');
  insert into public.categories(id,competition_id,name) values(category_id,competition_id,'Categoria de teste');
  payload := public.save_public_registration_form(event_id,true,
    '[{"key":"professor","label":"Professor","type":"text","required":true}]'::jsonb);
  form_token := (payload ->> 'token')::uuid;
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  payload := public.public_registration_form(form_token);
  if payload is null or jsonb_array_length(payload -> 'categories')<>1 then raise exception 'formulário público indisponível'; end if;
  perform public.submit_public_registration(form_token,category_id,'Pessoa de teste A',
    '{"age":"12","song_title":"Canção de teste","song_author":"Autora","professor":"Professor A"}'::jsonb);
  begin
    perform public.submit_public_registration(form_token,category_id,'Pessoa de teste B',
      '{"age":"13","song_title":"Cancao de teste!","song_author":"Autor","professor":"Professor B"}'::jsonb);
  exception when others then
    if sqlerrm like '%song already selected%' then repeated_blocked := true; else raise; end if;
  end;
  if not repeated_blocked then raise exception 'música duplicada foi aceita'; end if;
  perform public.submit_public_registration(form_token,category_id,'Pessoa de teste B',
    '{"age":"13","song_title":"Outra canção","song_author":"Autor","professor":"Professor B"}'::jsonb);
  payload := public.public_registration_form(form_token);
  if jsonb_array_length(payload -> 'taken_songs')<>2 then raise exception 'lista de músicas incorreta'; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claims',json_build_object('sub',actor::text,'role','authenticated')::text,true);
  perform public.finalize_event_and_snapshot(event_id);
  snapshot := public.get_event_closure_report(event_id) -> 'snapshot';
  if jsonb_array_length(snapshot -> 'registrations')<>2 then raise exception 'relatório não preservou inscrições'; end if;
  if snapshot -> 'event' ->> 'requires_payment' <> 'false' then raise exception 'pagamento opcional não foi preservado no relatório'; end if;
  if snapshot -> 'registrations' -> 0 -> 'additional_data' -> '_labels' ->> 'professor' <> 'Professor' then
    raise exception 'relatório não preservou rótulo dos dados adicionais';
  end if;
  begin
    update public.registrations r set attendance_confirmed=true
    where r.event_id=(snapshot -> 'event' ->> 'id')::uuid;
  exception when others then
    if sqlerrm like '%closed event records cannot be changed%' then edit_blocked := true; else raise; end if;
  end;
  if not edit_blocked then raise exception 'evento encerrado permitiu alterar inscrição'; end if;
  if (select status from public.events where id=event_id) <> 'finished' then raise exception 'evento não foi finalizado'; end if;
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  begin
    perform public.submit_public_registration(form_token,category_id,'Pessoa de teste C',
      '{"age":"14","song_title":"Terceira canção","song_author":"Autor","professor":"Professor C"}'::jsonb);
  exception when others then
    if sqlerrm like '%registration is not open%' then closed_blocked := true; else raise; end if;
  end;
  if not closed_blocked then raise exception 'evento encerrado aceitou inscrição'; end if;
end;
$$;

ROLLBACK;
