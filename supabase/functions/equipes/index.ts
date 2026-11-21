// Edge Function « equipes » : génération d'équipes côté serveur.
// Les niveaux/genres/rôles (table `profils`) ne quittent jamais ce fichier : seuls des noms sortent.
// Actions :
//   brouillon : Nico (code admin) demande une proposition ; rien n'est enregistré.
//   auto      : un joueur « Présent » génère les équipes pendant la séance ; première demande gagnante, verrouillé.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { generer, choisirTerrains, type Joueur, type Mode } from './moteur.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, content-type, authorization, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const rep = (corps: unknown, status = 200) =>
  new Response(JSON.stringify(corps), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const erreur = (message: string, status = 400) => rep({ erreur: message }, status);

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

// ---------- heure de Paris ----------
function maintenantParis() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('fr-CA', {
      timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map(x => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}
const enMinutes = (h: string) => { const [a, b] = h.split(':'); return Number(a) * 60 + Number(b); };
const jourSemaine = (date: string) => new Date(date + 'T12:00:00Z').getUTCDay(); // 2 = mardi

// ---------- données ----------
async function profilsPour(ids: string[]) {
  const { data: js } = await db.from('joueurs').select('id, prenom, equipe').in('id', ids);
  const { data: ps } = await db.from('profils').select('joueur_id, niveau, genre, passeur').in('joueur_id', ids);
  const pr = new Map((ps ?? []).map((p: any) => [p.joueur_id, p]));
  return (js ?? []).map((j: any): Joueur => {
    const p: any = pr.get(j.id);
    return {
      n: j.prenom,
      niveau: p?.niveau ?? 2.5,
      genre: p?.genre === 1 || p?.genre === 2 ? p.genre : null,
      passeur: p?.passeur === 1 || p?.passeur === 2 ? p.passeur : 0,
      club: j.equipe === 'Blocklieu' || j.equipe === 'AceCules' ? j.equipe : null,
    };
  });
}

async function candidats(seance: string, inclurePasSur: boolean, extraNoms: string[] = []) {
  const statuts = inclurePasSur ? ['present', 'pas_sur'] : ['present'];
  const { data: rs } = await db.from('reponses').select('joueur_id, statut').eq('seance_id', seance).in('statut', statuts);
  const ids = (rs ?? []).map((r: any) => r.joueur_id);
  let joueurs = ids.length ? await profilsPour(ids) : [];
  if (extraNoms.length) {
    const { data: ex } = await db.from('joueurs').select('id').in('prenom', extraNoms).eq('actif', true);
    const deja = new Set(joueurs.map(j => j.n));
    const nouveaux = await profilsPour((ex ?? []).map((x: any) => x.id));
    joueurs = joueurs.concat(nouveaux.filter(j => !deja.has(j.n)));
  }
  const { data: inv } = await db.from('invites').select('prenom').eq('seance_id', seance).eq('statut', 'accepte');
  for (const i of inv ?? []) {
    const n = `${i.prenom} (invité)`;
    if (!joueurs.some(j => j.n === n)) joueurs.push({ n, niveau: 2.5, genre: null, passeur: 0, club: null });
  }
  return joueurs;
}

// ---------- actions ----------
async function brouillon(b: any) {
  const { error } = await db.rpc('admin_verifier', { p_code: String(b.code ?? '') });
  if (error) return erreur('Code incorrect', 403);
  const mode: Mode = b.mode === 'competition' ? 'competition' : 'equilibre';
  const terrains = Math.min(3, Math.max(1, Math.floor(Number(b.terrains) || 1)));
  const fixes: Record<string, number> = {};
  if (b.fixes && typeof b.fixes === 'object') {
    for (const [n, i] of Object.entries(b.fixes)) if (Number.isInteger(i)) fixes[n] = i as number;
  }
  const joueurs = await candidats(String(b.seance), !!b.inclurePasSur, Object.keys(fixes).filter(n => !n.endsWith('(invité)')));
  const r = generer({ joueurs, terrains, mode, fixes });
  return rep(r);
}

async function auto(b: any) {
  const { data: s } = await db.from('seances')
    .select('id, date, debut, fin, annulee, equipes_match, composition').eq('id', b.seance).maybeSingle();
  if (!s || s.annulee) return erreur('Séance indisponible');
  if (s.composition) return rep({ deja: true, composition: s.composition });

  const now = maintenantParis();
  if (s.date !== now.date || now.min < enMinutes(s.debut) || now.min >= enMinutes(s.fin)) {
    return erreur('Disponible seulement pendant la séance');
  }
  const { data: moi } = await db.from('reponses').select('statut, joueurs!inner(actif)')
    .eq('seance_id', s.id).eq('joueur_id', b.joueur).maybeSingle();
  if (!moi || moi.statut !== 'present' || !(moi as any).joueurs?.actif) return erreur('Réservé aux joueurs présents', 403);

  const joueurs = await candidats(s.id, false);
  if (joueurs.length < 6) return erreur('Pas assez de joueurs présents');
  const max = jourSemaine(s.date) === 2 ? 1 : (s.equipes_match?.length ? 2 : 3);
  const C = choisirTerrains(joueurs.length, max);
  const r = generer({ joueurs, terrains: C, mode: 'equilibre' });
  const compo = {
    terrains: r.terrains, equipes: r.equipes, remplacants: r.nonPlaces,
    auto: true, genere_le: new Date().toISOString(),
  };
  // Écriture atomique : seule la première demande aboutit
  const { data: maj } = await db.from('seances').update({ composition: compo }).eq('id', s.id).is('composition', null).select('id');
  if (!maj?.length) {
    const { data: ex } = await db.from('seances').select('composition').eq('id', s.id).maybeSingle();
    return rep({ deja: true, composition: ex?.composition ?? compo });
  }
  return rep({ deja: false, composition: compo });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return erreur('Méthode non autorisée', 405);
  try {
    const b = await req.json();
    if (b.action === 'brouillon') return await brouillon(b);
    if (b.action === 'auto') return await auto(b);
    return erreur('Action inconnue');
  } catch (e) {
    console.error(e);
    return erreur('Erreur serveur', 500);
  }
});
