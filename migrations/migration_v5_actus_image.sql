-- ============================================================
-- Migration v5 : image d'aperçu pour les actus
-- À lancer UNE FOIS dans Supabase > SQL Editor (après migration_v4_actus_liens.sql)
-- ============================================================

alter table actus add column if not exists image text
  check (image is null or image ~* '^https://[^[:space:]]+$');

create or replace function actus_liste() returns json
language sql security definer set search_path = public stable as $$
  select coalesce(json_agg(a order by a.epingle desc, a.created_at desc), '[]'::json)
  from (select id, titre, texte, url, image, date_evenement, epingle, created_at
        from actus order by epingle desc, created_at desc limit 30) a;
$$;

drop function if exists admin_publier_actu(text, text, text, text, date, boolean);

create or replace function admin_publier_actu(p_code text, p_titre text, p_texte text,
                                              p_url text, p_date date, p_image text, p_epingle boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform admin_ok(p_code);
  p_titre := btrim(coalesce(p_titre, ''));
  p_url := nullif(btrim(coalesce(p_url, '')), '');
  p_image := nullif(btrim(coalesce(p_image, '')), '');
  if length(p_titre) not between 1 and 120 then raise exception 'Titre invalide (1 à 120 caractères)'; end if;
  if length(coalesce(p_texte, '')) > 4000 then raise exception 'Texte trop long (4000 caractères maximum)'; end if;
  if p_url is not null and (length(p_url) > 500 or p_url !~* '^https?://[^[:space:]]+$') then
    raise exception 'Lien invalide : il doit commencer par https://';
  end if;
  if p_image is not null and (length(p_image) > 1000 or p_image !~* '^https://[^[:space:]]+$') then
    p_image := null;  -- image inutilisable : on publie sans
  end if;
  insert into actus (titre, texte, url, image, date_evenement, epingle)
  values (p_titre, coalesce(p_texte, ''), p_url, p_image, p_date, coalesce(p_epingle, false));
end $$;
