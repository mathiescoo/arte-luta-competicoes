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
