-- ============================================================
-- Migration v3 : onglet Actus
-- À lancer UNE FOIS dans Supabase > SQL Editor (après migration_v2.sql)
-- ============================================================

create table if not exists actus (
  id uuid primary key default gen_random_uuid(),
  titre text not null,
  texte text not null default '',
  epingle boolean not null default false,
  created_at timestamptz not null default now()
);
alter table actus enable row level security;

-- Lecture publique : les 30 dernières actus, épinglées en premier
create or replace function actus_liste() returns json
language sql security definer set search_path = public stable as $$
  select coalesce(json_agg(a order by a.epingle desc, a.created_at desc), '[]'::json)
  from (select id, titre, texte, epingle, created_at
        from actus order by epingle desc, created_at desc limit 30) a;
$$;

-- Écriture réservée à Nico (code admin)
create or replace function admin_publier_actu(p_code text, p_titre text, p_texte text, p_epingle boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform admin_ok(p_code);
  p_titre := btrim(coalesce(p_titre, ''));
  if length(p_titre) not between 1 and 120 then raise exception 'Titre invalide (1 à 120 caractères)'; end if;
  if length(coalesce(p_texte, '')) > 4000 then raise exception 'Texte trop long (4000 caractères maximum)'; end if;
  insert into actus (titre, texte, epingle) values (p_titre, coalesce(p_texte, ''), coalesce(p_epingle, false));
end $$;

create or replace function admin_supprimer_actu(p_code text, p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform admin_ok(p_code);
  delete from actus where id = p_id;
end $$;
