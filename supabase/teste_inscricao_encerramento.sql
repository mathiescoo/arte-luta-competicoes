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
