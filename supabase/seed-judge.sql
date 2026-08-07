-- Crie primeiro a conta do juiz em Authentication > Users.
-- Depois troque os valores abaixo e execute este script no SQL Editor.
do $$
declare
  judge_email text := 'EMAIL_DO_JUIZ_AQUI';
  judge_name text := 'NOME_DO_JUIZ_AQUI';
  judge_id uuid;
  org_id uuid;
begin
  select id into judge_id from auth.users where lower(email)=lower(judge_email);
  if judge_id is null then raise exception 'Usuário % não encontrado em Authentication', judge_email; end if;
  select organization_id into org_id from public.user_roles where role='admin' limit 1;
  if org_id is null then raise exception 'Nenhuma organização administradora encontrada'; end if;
  insert into public.profiles(id,full_name) values(judge_id,judge_name)
  on conflict(id) do update set full_name=excluded.full_name;
  insert into public.user_roles(user_id,organization_id,role) values(judge_id,org_id,'judge')
  on conflict do nothing;
end $$;
