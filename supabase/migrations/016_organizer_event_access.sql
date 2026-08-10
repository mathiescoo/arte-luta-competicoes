-- Faz o papel Organizadora/Organizador realmente operar os eventos da sua organização.
-- Antes, ele aparecia na gestão de usuários mas não passava pelas políticas de eventos.

create or replace function public.can_manage_event(eid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1
    from public.events e
    where e.id = eid
      and (
        exists(
          select 1 from public.user_roles ur
          where ur.user_id = auth.uid()
            and ur.organization_id = e.organization_id
            and ur.role in ('admin', 'organizer')
        )
        or exists(
          select 1 from public.event_users eu
          where eu.event_id = e.id
            and eu.user_id = auth.uid()
            and eu.role = 'organizer'
        )
      )
  );
$$;

revoke all on function public.judge_live_matches() from public;
grant execute on function public.judge_live_matches() to authenticated;
