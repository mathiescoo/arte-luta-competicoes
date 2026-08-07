create table public.judge_applications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  user_id uuid not null unique references auth.users on delete cascade,
  full_name text not null,
  email text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
alter table public.judge_applications enable row level security;
create policy "applicant reads own request" on public.judge_applications for select using (user_id=auth.uid());
create policy "admins manage applications" on public.judge_applications for all using (public.is_admin(organization_id)) with check (public.is_admin(organization_id));
create policy "admins manage organization roles" on public.user_roles for all using (public.is_admin(organization_id)) with check (public.is_admin(organization_id));

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
declare
  default_org uuid;
  requested_role text;
begin
  insert into public.profiles(id,full_name) values(new.id,coalesce(new.raw_user_meta_data->>'full_name','Novo usuário')) on conflict(id) do nothing;
  requested_role:=new.raw_user_meta_data->>'requested_role';
  if requested_role='judge' then
    select id into default_org from public.organizations order by created_at limit 1;
    if default_org is not null then
      insert into public.judge_applications(organization_id,user_id,full_name,email)
      values(default_org,new.id,coalesce(new.raw_user_meta_data->>'full_name','Novo juiz'),coalesce(new.email,''))
      on conflict(user_id) do nothing;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();
