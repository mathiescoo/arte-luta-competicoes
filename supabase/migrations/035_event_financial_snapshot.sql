-- Acrescenta ao registro imutável os valores informados manualmente antes do encerramento.
-- Os relatórios já salvos não são alterados.
begin;

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
      'requires_payment',coalesce(ev.settings ->> 'require_payment','false') = 'true',
      'financial',coalesce(ev.settings -> 'financial_report','{}'::jsonb)),
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

notify pgrst, 'reload schema';
commit;
