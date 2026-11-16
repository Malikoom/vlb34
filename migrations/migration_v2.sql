-- ============================================================
-- Migration v2 : à lancer UNE FOIS dans Supabase > SQL Editor,
-- après schema.sql, AVANT de publier le nouvel index.html
-- ============================================================

-- ---------- Tables ----------
alter table reponses alter column statut drop not null;
alter table reponses drop constraint if exists reponses_statut_check;
alter table reponses add constraint reponses_statut_check
  check (statut in ('present','pas_sur','absent','match'));
alter table reponses add column if not exists apero boolean not null default false;

alter table seances add column if not exists apero boolean not null default false;
alter table seances add column if not exists equipes_match text[] not null default '{}';

create table if not exists invites (
  id uuid primary key default gen_random_uuid(),
  seance_id uuid not null references seances(id) on delete cascade,
  demandeur_id uuid not null references joueurs(id) on delete cascade,
  prenom text not null,
  statut text not null default 'attente' check (statut in ('attente','accepte','refuse')),
  created_at timestamptz not null default now()
);
alter table invites enable row level security;

-- ---------- Fonctions internes (non appelables depuis le site) ----------
create or replace function verif_reponse(p_seance uuid, p_joueur uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from joueurs where id = p_joueur and actif) then
    raise exception 'Joueur inconnu';
  end if;
  if not exists (select 1 from seances where id = p_seance and not annulee
                 and date >= (now() at time zone 'Europe/Paris')::date) then
    raise exception 'Séance passée, annulée ou inconnue';
  end if;
end $$;

create or replace function maj_statut(p_seance uuid, p_joueur uuid, p_statut text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_statut, '') = '' then
    update reponses set statut = null, updated_at = now()
      where seance_id = p_seance and joueur_id = p_joueur;
    delete from reponses
      where seance_id = p_seance and joueur_id = p_joueur and statut is null and not apero;
  else
    insert into reponses (seance_id, joueur_id, statut) values (p_seance, p_joueur, p_statut)
    on conflict (seance_id, joueur_id) do update set statut = excluded.statut, updated_at = now();
  end if;
end $$;

revoke execute on function verif_reponse(uuid, uuid) from public, anon, authenticated;
revoke execute on function maj_statut(uuid, uuid, text) from public, anon, authenticated;

-- ---------- Lecture ----------
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
          'apero',   count(*) filter (where apero))
         from reponses r where r.seance_id = s.id) as nb,
      coalesce((select json_agg(j.prenom order by j.prenom)
         from reponses r join joueurs j on j.id = r.joueur_id
         where r.seance_id = s.id and r.statut = 'present'), '[]'::json) as presents,
      (select statut from reponses r where r.seance_id = s.id and r.joueur_id = p_joueur) as moi,
      coalesce((select r.apero from reponses r where r.seance_id = s.id and r.joueur_id = p_joueur), false) as moi_apero,
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

-- ---------- Écriture joueur ----------
create or replace function repondre(p_seance uuid, p_joueur uuid, p_statut text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform verif_reponse(p_seance, p_joueur);
  perform maj_statut(p_seance, p_joueur, p_statut);
end $$;

create or replace function repondre_apero(p_seance uuid, p_joueur uuid, p_apero boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform verif_reponse(p_seance, p_joueur);
  if not exists (select 1 from seances where id = p_seance and apero) then
    raise exception 'Pas d''apéro prévu pour cette séance';
  end if;
  if p_apero then
    insert into reponses (seance_id, joueur_id, apero) values (p_seance, p_joueur, true)
    on conflict (seance_id, joueur_id) do update set apero = true;
  else
    update reponses set apero = false where seance_id = p_seance and joueur_id = p_joueur;
    delete from reponses
      where seance_id = p_seance and joueur_id = p_joueur and statut is null and not apero;
  end if;
end $$;

create or replace function demander_invite(p_seance uuid, p_joueur uuid, p_prenom text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform verif_reponse(p_seance, p_joueur);
  p_prenom := btrim(coalesce(p_prenom, ''));
  if length(p_prenom) not between 1 and 40 then raise exception 'Prénom invalide'; end if;
  if (select count(*) from invites where seance_id = p_seance and demandeur_id = p_joueur) >= 3 then
    raise exception '3 demandes maximum par séance';
  end if;
  insert into invites (seance_id, demandeur_id, prenom) values (p_seance, p_joueur, p_prenom);
end $$;

-- ---------- Écriture admin ----------
drop function if exists admin_annuler(text, uuid, boolean, text);

create or replace function admin_maj_seance(p_code text, p_seance uuid, p_annulee boolean,
                                            p_note text, p_apero boolean, p_equipes text[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform admin_ok(p_code);
  update seances set annulee = p_annulee, note = nullif(btrim(p_note), ''),
                     apero = p_apero, equipes_match = coalesce(p_equipes, '{}')
  where id = p_seance;
end $$;

create or replace function admin_set_reponse(p_code text, p_seance uuid, p_joueur uuid, p_statut text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform admin_ok(p_code);
  perform maj_statut(p_seance, p_joueur, p_statut);
end $$;

create or replace function admin_decider_invite(p_code text, p_invite uuid, p_statut text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform admin_ok(p_code);
  update invites set statut = p_statut where id = p_invite;
end $$;

create or replace function admin_detail(p_code text, p_seance uuid) returns json
language plpgsql security definer set search_path = public as $$
declare res json;
begin
  perform admin_ok(p_code);
  select json_build_object(
    'joueurs', (select coalesce(json_agg(json_build_object(
                  'id', j.id, 'prenom', j.prenom, 'statut', r.statut,
                  'apero', coalesce(r.apero, false), 'venu', (p.joueur_id is not null)
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
