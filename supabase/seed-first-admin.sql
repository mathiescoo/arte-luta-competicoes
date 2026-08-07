-- 1. Crie o usuário em Authentication > Users > Add user.
-- 2. Troque o e-mail abaixo pelo mesmo e-mail criado e execute este arquivo uma vez.
do $$
declare
  admin_email text := 'mathiescoo@gmail.com';
  admin_id uuid;
  org_id uuid;
begin
  select id into admin_id from auth.users where lower(email) = lower(admin_email);
  if admin_id is null then raise exception 'Usuário % não encontrado em Authentication', admin_email; end if;

  insert into public.organizations (name, slug)
  values ('Capoeira Arte-Luta Brasil', 'arte-luta-brasil')
  on conflict (slug) do update set name = excluded.name
  returning id into org_id;

  insert into public.profiles (id, full_name)
  values (admin_id, coalesce((select raw_user_meta_data->>'full_name' from auth.users where id=admin_id), 'Administrador'))
  on conflict (id) do update set full_name=excluded.full_name;

  insert into public.user_roles (user_id, organization_id, role)
  values (admin_id, org_id, 'admin') on conflict do nothing;
end $$;
