-- Impede que títulos de música se repitam dentro do mesmo evento,
-- inclusive no cadastro manual e nas importações. Não altera registros antigos.
begin;
create or replace function public.prevent_duplicate_event_song()
returns trigger language plpgsql security definer set search_path = public as $$
declare song_key text; event_model public.competition_model; existing_status public.event_status;
begin
  select e.status into existing_status from public.events e where e.id = new.event_id for update;
  if not found then raise exception 'event not found'; end if;
  if existing_status in ('finished','archived') then raise exception 'event is closed'; end if;
  select cp.model into event_model from public.categories cat
    join public.competitions cp on cp.id=cat.competition_id
    where cat.id=new.category_id and cp.event_id=new.event_id;
  if event_model is null then raise exception 'category does not belong to event'; end if;
  if event_model <> 'sum_score' then return new; end if;
  song_key := public.registration_song_key(new.data ->> 'song_title');
  if song_key = '' then return new; end if;
  if tg_op = 'UPDATE' and new.event_id=old.event_id
    and public.registration_song_key(old.data ->> 'song_title')=song_key
    and exists(select 1 from public.categories old_cat join public.competitions old_cp on old_cp.id=old_cat.competition_id
      where old_cat.id=old.category_id and old_cp.model='sum_score') then return new; end if;
  if exists(select 1 from public.registrations r join public.categories c on c.id=r.category_id
    join public.competitions cp on cp.id=c.competition_id
    where r.event_id=new.event_id and cp.model='sum_score'
      and r.id <> new.id
      and not (r.participant_id=new.participant_id and r.category_id=new.category_id)
      and public.registration_song_key(r.data ->> 'song_title')=song_key) then
    raise exception 'song already selected';
  end if;
  return new;
end;
$$;
drop trigger if exists prevent_duplicate_event_song on public.registrations;
create trigger prevent_duplicate_event_song before insert or update of event_id,category_id,data on public.registrations
for each row execute function public.prevent_duplicate_event_song();
revoke all on function public.prevent_duplicate_event_song() from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
