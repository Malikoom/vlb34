-- ============================================================
-- Migration v6 : liste des participants et apéro "oui / non + ce que j'apporte"
-- À lancer UNE FOIS dans Supabase > SQL Editor (après migration_v5_actus_image.sql)
-- Poussez le nouvel index.html seulement APRÈS cette migration.
-- ============================================================

-- 1) Nouvelles colonnes (l'ancien booléen "apero" est converti puis supprimé à la fin)
alter table reponses add column if not exists apero_choix text check (apero_choix in ('oui','non'));
alter table reponses add column if not exists apero_apporte text;
update reponses set apero_choix = 'oui' where apero and apero_choix is null;

-- 2) Une réponse sans statut ni choix d'apéro n'a plus de raison d'exister
create or replace function maj_statut(p_seance uuid, p_joueur uuid, p_statut text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_statut, '') = '' then
    update reponses set statut = null, updated_at = now()
      where seance_id = p_seance and joueur_id = p_joueur;
    delete from reponses
      where seance_id = p_seance and joueur_id = p_joueur and statut is null and apero_choix is null;
  else
    insert into reponses (seance_id, joueur_id, statut) values (p_seance, p_joueur, p_statut)
    on conflict (seance_id, joueur_id) do update set statut = excluded.statut, updated_at = now();
  end if;
end $$;
revoke execute on function maj_statut(uuid, uuid, text) from public, anon, authenticated;

-- 3) Lecture : participants (avec leur réponse) et détail de l'apéro
create or replace function seances_liste(p_joueur uuid default null, p_jours_arriere int default 0) returns json
language sql security definer set search_path = public stable as $$
  select coalesce(json_agg(x order by x.date, x.debut), '[]'::json) from (
    select s.id, s.date, left(s.debut::text,5) as debut, left(s.fin::text,5) as fin,
      s.annulee, s.note, s.apero, s.equipes_match,
      (select json_build_object(
          'present', count(*) filter (where statut = 'present'),
          'pas_sur', count(*) filter (where statut = 'pas_sur'),
          'absent',  count(*) filter (where statut = 'absent'),
          'match',   count(*) filter (where statut = 'match'),
          'apero',   count(*) filter (where apero_choix = 'oui'))
         from reponses r where r.seance_id = s.id) as nb,
      coalesce((select json_agg(p order by p.ordre, p.prenom) from (
          select j.prenom, r.statut,
                 case r.statut when 'present' then 1 when 'pas_sur' then 2 when 'match' then 3 else 4 end as ordre
          from reponses r join joueurs j on j.id = r.joueur_id
          where r.seance_id = s.id and r.statut is not null
          union all
          select i.prenom || ' (invité)', 'present', 1
          from invites i where i.seance_id = s.id and i.statut = 'accepte'
        ) p), '[]'::json) as participants,
      coalesce((select json_agg(json_build_object('id', j.id, 'prenom', j.prenom, 'apporte', r.apero_apporte)
                                order by j.prenom)
                from reponses r join joueurs j on j.id = r.joueur_id
                where r.seance_id = s.id and r.apero_choix = 'oui'), '[]'::json) as apero_liste,
      (select statut from reponses r where r.seance_id = s.id and r.joueur_id = p_joueur) as moi,
      (select apero_choix from reponses r where r.seance_id = s.id and r.joueur_id = p_joueur) as moi_apero,
      exists (select 1 from joueurs j where j.id = p_joueur and j.equipe = any (s.equipes_match)) as mon_match,
      (select count(*) from invites i where i.seance_id = s.id and i.statut = 'accepte') as nb_invites,
      (select count(*) from invites i where i.seance_id = s.id and i.statut = 'attente') as nb_attente,
      coalesce((select json_agg(json_build_object('prenom', i.prenom, 'statut', i.statut) order by i.created_at)
         from invites i where i.seance_id = s.id and i.demandeur_id = p_joueur), '[]'::json) as mes_invites,
      (select count(*) from presences p where p.seance_id = s.id) as nb_venus
    from seances s
    where s.date >= (now() at time zone 'Europe/Paris')::date - p_jours_arriere
  ) x;
$$;

-- 4) Écriture : choix d'apéro ('oui' + ce que j'apporte, 'non', ou '' pour effacer)
drop function if exists repondre_apero(uuid, uuid, boolean);

create or replace function repondre_apero(p_seance uuid, p_joueur uuid, p_choix text, p_apporte text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform verif_reponse(p_seance, p_joueur);
  if not exists (select 1 from seances where id = p_seance and apero) then
    raise exception 'Pas d''apéro prévu pour cette séance';
  end if;
  if coalesce(p_choix, '') = '' then
    update reponses set apero_choix = null, apero_apporte = null
      where seance_id = p_seance and joueur_id = p_joueur;
    delete from reponses
      where seance_id = p_seance and joueur_id = p_joueur and statut is null and apero_choix is null;
  elsif p_choix in ('oui', 'non') then
    insert into reponses (seance_id, joueur_id, apero_choix, apero_apporte)
    values (p_seance, p_joueur, p_choix,
            case when p_choix = 'oui' then nullif(left(btrim(coalesce(p_apporte, '')), 80), '') end)
    on conflict (seance_id, joueur_id) do update
      set apero_choix = excluded.apero_choix, apero_apporte = excluded.apero_apporte;
  else
    raise exception 'Choix invalide';
  end if;
end $$;

-- 5) Mode Nico : le 🍻 à côté d'un nom signifie "vient à l'apéro"
create or replace function admin_detail(p_code text, p_seance uuid) returns json
language plpgsql security definer set search_path = public as $$
declare res json;
begin
  perform admin_ok(p_code);
  select json_build_object(
    'joueurs', (select coalesce(json_agg(json_build_object(
                  'id', j.id, 'prenom', j.prenom, 'statut', r.statut,
                  'apero', (r.apero_choix = 'oui'), 'venu', (p.joueur_id is not null)
                ) order by j.prenom), '[]'::json)
                from joueurs j
                left join reponses r on r.joueur_id = j.id and r.seance_id = p_seance
                left join presences p on p.joueur_id = j.id and p.seance_id = p_seance
                where j.actif),
    'invites', (select coalesce(json_agg(json_build_object(
                  'id', i.id, 'prenom', i.prenom, 'statut', i.statut, 'demandeur', d.prenom
                ) order by i.created_at), '[]'::json)
                from invites i join joueurs d on d.id = i.demandeur_id
                where i.seance_id = p_seance)
  ) into res;
  return res;
end $$;

-- 6) Ménage : l'ancien booléen n'est plus utilisé
alter table reponses drop column if exists apero;
