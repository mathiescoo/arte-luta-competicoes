alter table public.registrations enable row level security;
create policy "managers manage participants" on public.participants for all
using (exists(select 1 from public.user_roles ur where ur.organization_id=participants.organization_id and ur.user_id=auth.uid() and ur.role in ('admin','organizer')))
with check (exists(select 1 from public.user_roles ur where ur.organization_id=participants.organization_id and ur.user_id=auth.uid() and ur.role in ('admin','organizer')));
create policy "event managers manage registrations" on public.registrations for all
using (public.can_manage_event(event_id)) with check (public.can_manage_event(event_id));
