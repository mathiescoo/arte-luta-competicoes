alter table public.judge_assignments enable row level security;
create policy "managers manage judge assignments" on public.judge_assignments for all
using (public.can_manage_event(event_id)) with check (public.can_manage_event(event_id));

create or replace function public.can_view_profile(target_user uuid) returns boolean
language sql stable security definer set search_path=public as $$
  select target_user=auth.uid() or exists(
    select 1 from public.user_roles self_role
    join public.user_roles target_role on target_role.organization_id=self_role.organization_id
    where self_role.user_id=auth.uid() and self_role.role='admin' and target_role.user_id=target_user
  )
$$;
drop policy if exists "users read own profile" on public.profiles;
create policy "members read authorized profiles" on public.profiles for select using (public.can_view_profile(id));
