create or replace function public.request_judge_access()
returns void language plpgsql security definer set search_path=public as $$
declare org_id uuid; user_email text; user_name text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select id into org_id from public.organizations order by created_at limit 1;
  select email,coalesce(raw_user_meta_data->>'full_name','Novo juiz') into user_email,user_name from auth.users where id=auth.uid();
  if org_id is null then raise exception 'organization not found'; end if;
  insert into public.profiles(id,full_name) values(auth.uid(),user_name) on conflict(id) do nothing;
  insert into public.judge_applications(organization_id,user_id,full_name,email) values(org_id,auth.uid(),user_name,coalesce(user_email,'')) on conflict(user_id) do nothing;
end; $$;
grant execute on function public.request_judge_access() to authenticated;
