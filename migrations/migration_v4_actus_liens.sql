-- ============================================================
-- Migration v4 : actus avec lien et date d'événement
-- À lancer UNE FOIS dans Supabase > SQL Editor (après migration_v3_actus.sql)
-- ============================================================

alter table actus add column if not exists url text
  check (url is null or url ~* '^https?://[^[:space:]]+$');
alter table actus add column if not exists date_evenement date;

create or replace function actus_liste() returns json
language sql security definer set search_path = public stable as $$
  select coalesce(json_agg(a order by a.epingle desc, a.created_at desc), '[]'::json)
  from (select id, titre, texte, url, date_evenement, epingle, created_at
        from actus order by epingle desc, created_at desc limit 30) a;
$$;

drop function if exists admin_publier_actu(text, text, text, boolean);

create or replace function admin_publier_actu(p_code text, p_titre text, p_texte text,
                                              p_url text, p_date date, p_epingle boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform admin_ok(p_code);
  p_titre := btrim(coalesce(p_titre, ''));
  p_url := nullif(btrim(coalesce(p_url, '')), '');
  if length(p_titre) not between 1 and 120 then raise exception 'Titre invalide (1 à 120 caractères)'; end if;
  if length(coalesce(p_texte, '')) > 4000 then raise exception 'Texte trop long (4000 caractères maximum)'; end if;
  if p_url is not null and (length(p_url) > 500 or p_url !~* '^https?://[^[:space:]]+$') then
    raise exception 'Lien invalide : il doit commencer par https://';
  end if;
  insert into actus (titre, texte, url, date_evenement, epingle)
  values (p_titre, coalesce(p_texte, ''), p_url, p_date, coalesce(p_epingle, false));
end $$;
