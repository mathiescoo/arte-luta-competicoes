-- Acesso de juiz limitado ao ciclo dos eventos, preservando atribuição histórica.
-- Contas/perfis são mantidos para que fichas, votos e relatórios continuem auditáveis.
begin;

-- Permite desativar designações como parte da finalização, mesmo que uma
-- avaliação já tenha sido aberta. A flag só é definida pelo gatilho abaixo,
-- durante a inserção protegida do relatório de encerramento.
create or replace function public.assert_scoring_jury_unlocked(
  target_competition uuid,
  target_category uuid
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('app.event_closure', true), '') = 'true' then
    return;
  end if;
  if target_competition is null then return; end if;
  if exists (
    select 1 from public.competitions competition
    where competition.id = target_competition
      and competition.model = 'sum_score'::public.competition_model
  ) and exists (
    select 1 from public.presentations presentation
    join public.categories category on category.id = presentation.category_id
    where category.competition_id = target_competition
      and (target_category is null or presentation.category_id = target_category)
      and presentation.status in ('live', 'finished')
  ) then
    raise exception 'judge assignments are locked after the first scoring evaluation opens; restart every completed presentation in this category before changing the jury';
  end if;
end;
$$;

create or replace function public.remove_judges_after_event_closure()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  event_org uuid;
  revoke_judges uuid[];
  judge_id uuid;
begin
  if auth.uid() is null or new.closed_by is distinct from auth.uid()
     or not public.can_manage_event(new.event_id) then
    raise exception 'not authorized to close event and remove its judge access';
  end if;
  select organization_id into event_org from public.events where id = new.event_id;
  if event_org is null then raise exception 'event not found'; end if;

  -- This GUC is transaction-local. It narrowly authorizes cleanup inside the
  -- same authenticated finalization transaction; failure rolls everything back.
  perform set_config('app.event_closure', 'true', true);

  -- Keep assignment rows and scorecard/vote references as immutable history;
  -- only turn off their operational access.
  update public.judge_assignments
  set active = false, ends_at = coalesce(ends_at, clock_timestamp())
  where event_id = new.event_id and active;

  delete from public.event_users
  where event_id = new.event_id and role = 'judge';

  -- A judge remains available if still assigned to or explicitly linked with
  -- another event that has not been closed. Otherwise remove only the judge role.
  select coalesce(array_agg(ur.user_id), '{}'::uuid[]) into revoke_judges
  from public.user_roles ur
  where ur.organization_id = event_org and ur.role = 'judge'
    and not exists (
      select 1 from public.judge_assignments ja
      join public.events other_event on other_event.id = ja.event_id
      where ja.judge_id = ur.user_id and ja.active
        and other_event.organization_id = event_org and other_event.id <> new.event_id
        and other_event.status not in ('finished', 'archived')
        and not exists(select 1 from public.event_closure_reports report where report.event_id = other_event.id)
    )
    and not exists (
      select 1 from public.event_users eu
      join public.events other_event on other_event.id = eu.event_id
      where eu.user_id = ur.user_id and eu.role = 'judge' and eu.event_id <> new.event_id
        and other_event.organization_id = event_org
        and other_event.status not in ('finished', 'archived')
        and not exists(select 1 from public.event_closure_reports report where report.event_id = other_event.id)
    );

  delete from public.user_roles
  where organization_id = event_org and role = 'judge' and user_id = any(revoke_judges);

  -- Remove only approved access applications for judges whose role was revoked.
  -- Pending requests and the administrator's membership are untouched.
  delete from public.judge_applications
  where organization_id = event_org and status = 'approved' and user_id = any(revoke_judges);

  foreach judge_id in array revoke_judges loop
    insert into public.audit_logs(actor_id, event_id, action, entity_type, entity_id, details)
    values (auth.uid(), new.event_id, 'event_judge_access_removed', 'user_role', judge_id,
      jsonb_build_object('role', 'judge', 'reason', 'event_closed'));
  end loop;
  return new;
end;
$$;

drop trigger if exists remove_judges_after_event_closure on public.event_closure_reports;
create trigger remove_judges_after_event_closure
before insert on public.event_closure_reports
for each row execute function public.remove_judges_after_event_closure();

revoke all on function public.remove_judges_after_event_closure() from public, anon, authenticated;
revoke all on function public.assert_scoring_jury_unlocked(uuid, uuid) from public, anon, authenticated;

-- Limpa acessos que sobraram de eventos já encerrados antes desta atualização.
-- Apenas vínculos de juiz são removidos; perfis e contas preservam o histórico.
with removable_judges as (
  select ur.user_id, ur.organization_id
  from public.user_roles ur
  where ur.role = 'judge'
    and not exists (
      select 1 from public.judge_assignments ja
      join public.events e on e.id = ja.event_id
      where ja.judge_id = ur.user_id and ja.active and e.organization_id = ur.organization_id
        and e.status not in ('finished', 'archived')
        and not exists(select 1 from public.event_closure_reports report where report.event_id = e.id)
    )
    and not exists (
      select 1 from public.event_users eu
      join public.events e on e.id = eu.event_id
      where eu.user_id = ur.user_id and eu.role = 'judge' and e.organization_id = ur.organization_id
        and e.status not in ('finished', 'archived')
        and not exists(select 1 from public.event_closure_reports report where report.event_id = e.id)
    )
), removed_roles as (
  delete from public.user_roles ur
  using removable_judges removable
  where ur.user_id = removable.user_id and ur.organization_id = removable.organization_id and ur.role = 'judge'
  returning ur.user_id, ur.organization_id
)
delete from public.judge_applications application
using removed_roles removed
where application.user_id = removed.user_id and application.organization_id = removed.organization_id
  and application.status = 'approved';

delete from public.event_users eu
using public.events e, public.event_closure_reports report
where e.id = eu.event_id and report.event_id = e.id
  and e.status in ('finished', 'archived') and eu.role = 'judge';

notify pgrst, 'reload schema';
commit;
