-- ============================================================
-- Migration v7 : équipes du jour (composition manuelle par Nico)
-- À lancer UNE FOIS dans Supabase > SQL Editor (après migration_v6_apero.sql)
-- ============================================================

alter table seances add column if not exists composition jsonb;

-- Lecture publique : compositions enregistrées (hier, aujourd'hui et à venir)
-- Format : { "<id séance>": { "terrains": 2, "equipes": [["Seb","Léa"], [...], ...] } }
create or replace function equipes_du_jour() returns json
language sql security definer set search_path = public stable as $$
  select coalesce(json_object_agg(id::text, composition), '{}'::json)
  from seances
  where composition is not null
    and date >= (now() at time zone 'Europe/Paris')::date - 1;
$$;

-- Écriture réservée à Nico ; p_compo = null efface les équipes
create or replace function admin_sauver_equipes(p_code text, p_seance uuid, p_compo jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform admin_ok(p_code);
  if p_compo is not null and (jsonb_typeof(p_compo) <> 'object' or length(p_compo::text) > 6000) then
    raise exception 'Composition invalide';
  end if;
  update seances set composition = p_compo where id = p_seance;
end $$;
