-- Atualiza a organização criada pelo seed original sem tocar em outras organizações.
update public.organizations
set
  name = 'Arena Arte Luta',
  slug = case
    when not exists (
      select 1
      from public.organizations as existing
      where existing.slug = 'arena-arte-luta'
        and existing.id <> organizations.id
    ) then 'arena-arte-luta'
    else slug
  end
where slug = 'arte-luta-brasil'
   or name = 'Capoeira Arte-Luta Brasil';
