create policy "admins update organization" on public.organizations for update
using (public.is_admin(id)) with check (public.is_admin(id));
