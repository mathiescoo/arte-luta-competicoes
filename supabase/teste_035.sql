-- Executar apenas em transação revertida com ROLLBACK.
do $$
declare actor uuid; org uuid; event_id uuid := gen_random_uuid(); snapshot jsonb;
begin
  select user_id, organization_id into actor, org from public.user_roles where role='admin' limit 1;
  if actor is null then raise exception 'teste requer administrador existente'; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claims',json_build_object('sub',actor::text,'role','authenticated')::text,true);
  insert into public.events(id,organization_id,name,slug,status,created_by,settings)
  values(event_id,org,'Teste financeiro temporário','teste-financeiro-'||event_id::text,'preparing',actor,
    '{"require_payment":false,"financial_report":{"income_cents":1550,"expenses_cents":200,"notes":"Anotação de teste"}}'::jsonb);
  perform public.finalize_event_and_snapshot(event_id);
  snapshot := public.get_event_closure_report(event_id) -> 'snapshot';
  if snapshot -> 'event' -> 'financial' ->> 'income_cents' <> '1550'
     or snapshot -> 'event' -> 'financial' ->> 'expenses_cents' <> '200'
     or snapshot -> 'event' -> 'financial' ->> 'notes' <> 'Anotação de teste' then
    raise exception 'valores financeiros não foram preservados';
  end if;
  if snapshot -> 'event' ->> 'requires_payment' <> 'false' then raise exception 'pagamento opcional alterado'; end if;
end;
$$;
