// Moteur de génération d'équipes.
// Module pur : aucune dépendance, aucun accès réseau ni base de données.
// Les niveaux, genres et rôles entrent ici mais ne sortent JAMAIS : le résultat ne contient
// que des noms et des messages génériques.

export type Club = 'Blocklieu' | 'AceCules' | null;
export type Mode = 'equilibre' | 'competition';

export interface Joueur {
  n: string;                 // nom affiché (unique dans une génération)
  niveau: number;            // 1 (débutant) à 4 (confirmé) ; 2.5 si inconnu (invités)
  genre: 1 | 2 | null;       // null si inconnu
  passeur: 0 | 1 | 2;        // 0 non, 1 si besoin, 2 rôle principal
  club: Club;                // équipe de compétition
}

export interface Entree {
  joueurs: Joueur[];
  terrains: number;                  // nombre de terrains utilisés (2 équipes par terrain)
  mode: Mode;
  fixes?: Record<string, number>;    // joueurs déjà placés : nom -> index d'équipe (0 .. 2*terrains-1)
  rng?: () => number;                // injectable pour les tests
}

export interface Sortie {
  terrains: number;
  equipes: string[][];               // équipe 2t contre équipe 2t+1 sur le terrain t+1
  nonPlaces: string[];               // remplaçants : trop de joueurs pour les terrains
  avertissements: string[];          // messages génériques, sans niveau ni nom
}

export const MAX_EQUIPE = 6;
export const MIN_EQUIPE = 3;
const TAILLE_MATCH = 4;              // équipes du match de compétition : 4 joueurs

/** Plus petit nombre de terrains (dans la limite `max`) pour que les équipes ne dépassent pas 6. */
export function choisirTerrains(n: number, max: number): number {
  return Math.max(1, Math.min(max, Math.ceil(n / (2 * MAX_EQUIPE))));
}

// ---------- outils ----------
function melanger<T>(a: T[], rng: () => number): T[] {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}
const somme = (t: number[]) => t.reduce((a, b) => a + b, 0);
const moy = (t: Joueur[]) => (t.length ? somme(t.map(j => j.niveau)) / t.length : 0);

/** Place chaque joueur libre dans l'équipe la moins remplie (au hasard à égalité). */
function remplir(equipes: Joueur[][], libres: Joueur[], rng: () => number) {
  for (const j of melanger(libres, rng)) {
    const m = Math.min(...equipes.map(e => e.length));
    const cands = equipes.map((e, i) => (e.length === m ? i : -1)).filter(i => i >= 0);
    equipes[cands[Math.floor(rng() * cands.length)]].push(j);
  }
}

// ---------- fonctions de coût (plus bas = meilleur) ----------
function coutNiveau(eq: Joueur[][]): number {
  const tous = eq.flat();
  if (!tous.length) return 0;
  const mu = somme(tous.map(j => j.niveau)) / tous.length;
  let c = 0;
  for (const t of eq) if (t.length) c += 50 * (moy(t) - mu) ** 2;
  return c;
}

function coutEquilibre(eq: Joueur[][]): number {
  const tous = eq.flat();
  const n = tous.length;
  if (!n) return 0;
  const W = tous.filter(j => j.genre === 2).length;
  let c = coutNiveau(eq);
  for (const t of eq) {
    if (!t.length) continue;
    // passeurs : un « rôle principal » par équipe, à défaut un « si besoin »
    const n2 = t.filter(j => j.passeur === 2).length;
    const n1 = t.filter(j => j.passeur === 1).length;
    if (n2 === 0) c += n1 > 0 ? 12 : 100;
    if (n2 > 1) c += 4 * (n2 - 1);
    // joueurs les plus faibles : jamais deux débutants ensemble, éviter les niveaux 2 groupés
    const deb = t.filter(j => j.niveau <= 1).length;
    if (deb > 1) c += 60 * (deb * (deb - 1)) / 2;
    const faibles = t.filter(j => j.niveau <= 2).length;
    if (faibles > 1) c += 6 * (faibles * (faibles - 1)) / 2;
    // genres répartis à proportion de la taille de l'équipe
    const w = t.filter(j => j.genre === 2).length;
    c += 6 * (w - (W * t.length) / n) ** 2;
  }
  return c;
}

// ---------- recherche : tirage aléatoire + échanges qui n'aggravent pas le coût ----------
function resoudre(
  base: Joueur[][], libres: Joueur[], cout: (eq: Joueur[][]) => number,
  rng: () => number, essais = 12, iterations = 1500,
): Joueur[][] {
  if (!libres.length || !base.length) return base.map(t => t.slice());
  const modifiables = new Set(libres.map(j => j.n));
  let meilleur: Joueur[][] = base;
  let meilleurCout = Infinity;
  for (let e = 0; e < essais; e++) {
    const eq = base.map(t => t.slice());
    remplir(eq, libres, rng);
    let c = cout(eq);
    for (let it = 0; it < iterations; it++) {
      const a = Math.floor(rng() * eq.length);
      const b = Math.floor(rng() * eq.length);
      if (a === b || !eq[a].length || !eq[b].length) continue;
      const ia = Math.floor(rng() * eq[a].length);
      const ib = Math.floor(rng() * eq[b].length);
      const ja = eq[a][ia], jb = eq[b][ib];
      if (!modifiables.has(ja.n) || !modifiables.has(jb.n)) continue;
      eq[a][ia] = jb; eq[b][ib] = ja;
      const c2 = cout(eq);
      if (c2 <= c) c = c2; else { eq[a][ia] = ja; eq[b][ib] = jb; }
    }
    if (c < meilleurCout) { meilleurCout = c; meilleur = eq; }
  }
  return meilleur;
}

// ---------- modes ----------
function equilibre(equipes: Joueur[][], libres: Joueur[], nonPlaces: Joueur[], rng: () => number): Joueur[][] {
  const deja = equipes.reduce((a, t) => a + t.length, 0);
  const capacite = Math.max(0, MAX_EQUIPE * equipes.length - deja);
  if (libres.length > capacite) {
    // trop de monde : on garde en priorité les passeurs, les remplaçants sont tirés au hasard
    const ordre = melanger(libres, rng).sort((a, b) => (b.passeur > 0 ? 1 : 0) - (a.passeur > 0 ? 1 : 0));
    nonPlaces.push(...ordre.slice(capacite));
    libres = ordre.slice(0, capacite);
  }
  return resoudre(equipes, libres, coutEquilibre, rng);
}

/**
 * Compétition : terrain 1 = match Blocklieu (équipe 0) contre AceCules (équipe 1), 4 joueurs par équipe.
 * Si un groupe est incomplet, des joueurs sans équipe de compétition complètent (niveaux équilibrés
 * entre les deux équipes). Tous les autres joueurs se répartissent sur les terrains suivants.
 */
function competition(equipes: Joueur[][], libres: Joueur[], nonPlaces: Joueur[], rng: () => number): Joueur[][] {
  const clubs: Club[] = ['Blocklieu', 'AceCules'];
  let reste = libres.slice();
  const sel: Joueur[][] = [[], []];
  for (let t = 0; t < 2; t++) {
    const besoin = Math.max(0, TAILLE_MATCH - equipes[t].length);
    const pris = melanger(reste.filter(j => j.club === clubs[t]), rng).slice(0, besoin);
    sel[t].push(...pris);
    reste = reste.filter(j => !pris.includes(j));
  }
  for (let t = 0; t < 2; t++) {
    const besoin = Math.max(0, TAILLE_MATCH - equipes[t].length - sel[t].length);
    const pris = melanger(reste.filter(j => j.club === null), rng).slice(0, besoin);
    sel[t].push(...pris);
    reste = reste.filter(j => !pris.includes(j));
  }
  // équilibrer les niveaux des deux équipes du match en remplaçant un joueur par un autre du même groupe
  const ecart = () => Math.abs(moy([...equipes[0], ...sel[0]]) - moy([...equipes[1], ...sel[1]]));
  let c = ecart();
  for (let it = 0; it < 600 && c > 0; it++) {
    const t = rng() < 0.5 ? 0 : 1;
    if (!sel[t].length) continue;
    const i = Math.floor(rng() * sel[t].length);
    const sortant = sel[t][i];
    const cands = reste.filter(j => j.club === sortant.club);
    if (!cands.length) continue;
    const entrant = cands[Math.floor(rng() * cands.length)];
    sel[t][i] = entrant;
    const c2 = ecart();
    if (c2 <= c) { c = c2; reste[reste.indexOf(entrant)] = sortant; } else sel[t][i] = sortant;
  }
  equipes[0].push(...sel[0]);
  equipes[1].push(...sel[1]);

  const autres = equipes.slice(2);
  if (!autres.length) {            // un seul terrain : les autres joueurs restent remplaçants
    nonPlaces.push(...reste);
    return equipes;
  }
  const capacite = Math.max(0, MAX_EQUIPE * autres.length - autres.reduce((a, t) => a + t.length, 0));
  let aPlacer = reste;
  if (aPlacer.length > capacite) {
    const m = melanger(aPlacer, rng);
    nonPlaces.push(...m.slice(capacite));
    aPlacer = m.slice(0, capacite);
  }
  return [equipes[0], equipes[1], ...resoudre(autres, aPlacer, coutNiveau, rng)];
}

// ---------- messages : génériques, jamais de niveau ni de nom ----------
function diagnostics(eq: Joueur[][], nonPlaces: Joueur[], mode: Mode): string[] {
  const av: string[] = [];
  const pl = (n: number, s: string, p: string) => (n > 1 ? p : s);
  if (nonPlaces.length) {
    av.push(`${nonPlaces.length} ${pl(nonPlaces.length, 'joueur', 'joueurs')} sans équipe (remplaçant) : trop nombreux pour les terrains disponibles.`);
  }
  if (eq.some(t => t.length > 0 && t.length < MIN_EQUIPE)) av.push('Une équipe a moins de 3 joueurs.');
  if (eq.some(t => t.length > MAX_EQUIPE)) av.push('Une équipe dépasse 6 joueurs.');
  const actives = eq.filter(t => t.length);
  if (mode === 'competition') {
    if (eq.length >= 2 && (eq[0].length < TAILLE_MATCH || eq[1].length < TAILLE_MATCH)) {
      av.push('Match incomplet : pas assez de joueurs pour deux équipes de 4.');
    }
  } else {
    if (actives.some(t => !t.some(j => j.passeur > 0))) av.push('Une équipe n’a pas de passeur.');
    const w = actives.map(t => t.filter(j => j.genre === 2).length);
    const regle = actives.some(t => t.filter(j => j.niveau <= 1).length > 1)
      || (w.length > 0 && Math.max(...w) - Math.min(...w) > 1);
    if (regle) av.push('Une règle de répartition n’a pas pu être respectée.');
  }
  return av;
}

// ---------- point d'entrée ----------
export function generer(e: Entree): Sortie {
  const rng = e.rng ?? Math.random;
  const C = Math.max(1, Math.floor(e.terrains));
  const k = 2 * C;
  const noms = new Set(e.joueurs.map(j => j.n));
  if (noms.size !== e.joueurs.length) throw new Error('Noms en double');

  const fixes = e.fixes ?? {};
  const equipes: Joueur[][] = Array.from({ length: k }, () => []);
  const libres: Joueur[] = [];
  for (const j of e.joueurs) {
    const t = fixes[j.n];
    if (Number.isInteger(t) && t >= 0 && t < k) equipes[t].push(j); else libres.push(j);
  }
  const nonPlaces: Joueur[] = [];
  const resultat = e.mode === 'competition'
    ? competition(equipes, libres, nonPlaces, rng)
    : equilibre(equipes, libres, nonPlaces, rng);

  const tri = (a: string, b: string) => a.localeCompare(b, 'fr');
  return {
    terrains: C,
    equipes: resultat.map(t => t.map(j => j.n).sort(tri)),
    nonPlaces: nonPlaces.map(j => j.n).sort(tri),
    avertissements: diagnostics(resultat, nonPlaces, e.mode),
  };
}
