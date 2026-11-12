-- Impede que títulos de música se repitam dentro do mesmo evento,
-- inclusive no cadastro manual e nas importações. Não altera registros antigos.
begin;
create or replace function public.prevent_duplicate_event_song()
returns trigger language plpgsql security definer set search_path = public as $$
declare song_key text; event_model public.competition_model; existing_status public.event_status;
begin
  select e.status into existing_status from public.events e where e.id = new.event_id for update;
  if not found then raise exception 'event not found'; end if;
  if existing_status in ('finished','archived') then raise exception 'event is closed'; end if;
  select cp.model into event_model from public.categories cat
    join public.competitions cp on cp.id=cat.competition_id
    where cat.id=new.category_id and cp.event_id=new.event_id;
  if event_model is null then raise exception 'category does not belong to event'; end if;
  if event_model <> 'sum_score' then return new; end if;
  song_key := public.registration_song_key(new.data ->> 'song_title');
  if song_key = '' then return new; end if;
  if tg_op = 'UPDATE' and new.event_id=old.event_id
    and public.registration_song_key(old.data ->> 'song_title')=song_key
    and exists(select 1 from public.categories old_cat join public.competitions old_cp on old_cp.id=old_cat.competition_id
      where old_cat.id=old.category_id and old_cp.model='sum_score') then return new; end if;
  if exists(select 1 from public.registrations r join public.categories c on c.id=r.category_id
    join public.competitions cp on cp.id=c.competition_id
    where r.event_id=new.event_id and cp.model='sum_score'
      and r.id <> new.id
      and not (r.participant_id=new.participant_id and r.category_id=new.category_id)
      and public.registration_song_key(r.data ->> 'song_title')=song_key) then
    raise exception 'song already selected';
  end if;
  return new;
end;
$$;
drop trigger if exists prevent_duplicate_event_song on public.registrations;
create trigger prevent_duplicate_event_song before insert or update of event_id,category_id,data on public.registrations
for each row execute function public.prevent_duplicate_event_song();
revoke all on function public.prevent_duplicate_event_song() from public, anon, authenticated;
notify pgrst, 'reload schema';

-- Os dados deste teste são revertidos dentro de uma subtransação.
do $$
declare
  org uuid; actor uuid; event_a uuid := gen_random_uuid(); event_b uuid := gen_random_uuid();
  comp_a uuid := gen_random_uuid(); comp_b uuid := gen_random_uuid(); comp_games uuid := gen_random_uuid();
  cat_a uuid := gen_random_uuid(); cat_b uuid := gen_random_uuid(); cat_games uuid := gen_random_uuid();
  person_a uuid := gen_random_uuid(); person_b uuid := gen_random_uuid();
  duplicate_blocked boolean := false;
begin
  begin
    select ur.user_id, ur.organization_id into actor, org from public.user_roles ur where ur.role='admin' limit 1;
    if actor is null then raise exception 'teste requer administrador existente'; end if;
    insert into public.events(id,organization_id,name,slug,status,created_by) values
      (event_a,org,'Teste temporário de músicas A','teste-musicas-a-'||event_a::text,'preparing',actor),
      (event_b,org,'Teste temporário de músicas B','teste-musicas-b-'||event_b::text,'preparing',actor);
    insert into public.competitions(id,event_id,name,model) values
      (comp_a,event_a,'Música','sum_score'),(comp_b,event_b,'Música','sum_score'),(comp_games,event_a,'Jogos','digital_flags');
    insert into public.categories(id,competition_id,name) values
      (cat_a,comp_a,'Categoria A'),(cat_b,comp_b,'Categoria B'),(cat_games,comp_games,'Jogos');
    insert into public.participants(id,organization_id,full_name) values
      (person_a,org,'Pessoa temporária A'),(person_b,org,'Pessoa temporária B');
    insert into public.registrations(event_id,participant_id,category_id,data)
      values(event_a,person_a,cat_a,'{"song_title":"Canção da Roda"}'::jsonb);
    begin
      insert into public.registrations(event_id,participant_id,category_id,data)
        values(event_a,person_b,cat_a,'{"song_title":"cancao-da-roda!"}'::jsonb);
    exception when others then
      if sqlerrm like '%song already selected%' then duplicate_blocked := true; else raise; end if;
    end;
    if not duplicate_blocked then raise exception 'música repetida foi aceita no mesmo evento'; end if;
    insert into public.registrations(event_id,participant_id,category_id,data)
      values(event_b,person_b,cat_b,'{"song_title":"Canção da Roda"}'::jsonb);
    insert into public.registrations(event_id,participant_id,category_id,data)
      values(event_a,person_b,cat_games,'{"song_title":"Canção da Roda"}'::jsonb);
    insert into public.registrations(event_id,participant_id,category_id,data)
      values(event_a,person_a,cat_a,'{"song_title":"Canção da Roda","age":"10"}'::jsonb)
      on conflict(event_id,participant_id,category_id) do update set data=excluded.data;
    raise exception using errcode='PZ036', message='rollback dos dados temporários';
  exception when sqlstate 'PZ036' then null;
  end;
end;
$$;

commit;
