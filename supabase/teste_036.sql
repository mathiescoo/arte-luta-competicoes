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
