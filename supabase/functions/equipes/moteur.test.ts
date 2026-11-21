// Tests du moteur avec des joueurs synthétiques (aucune donnée réelle).
// Lancer : node --experimental-strip-types --test supabase/functions/equipes/moteur.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generer, choisirTerrains, type Joueur, type Club } from './moteur.ts';

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function jeu(n: number, seed = 1, opts: { bleu?: number; ace?: number } = {}): Joueur[] {
  const r = prng(seed);
  const js: Joueur[] = [];
  for (let i = 1; i <= n; i++) {
    const club: Club = i <= (opts.bleu ?? 0) ? 'Blocklieu' : i <= (opts.bleu ?? 0) + (opts.ace ?? 0) ? 'AceCules' : null;
    const niveau = i <= 3 ? 1 : 2 + Math.floor(r() * 3);
    js.push({
      n: 'J' + i, niveau,
      genre: r() < 0.35 ? 2 : 1,
      passeur: (r() < 0.2 ? 2 : r() < 0.3 ? 1 : 0) as 0 | 1 | 2,
      club,
    });
  }
  return js;
}

test('choisirTerrains', () => {
  assert.equal(choisirTerrains(8, 3), 1);
  assert.equal(choisirTerrains(12, 3), 1);
  assert.equal(choisirTerrains(13, 3), 2);
  assert.equal(choisirTerrains(25, 3), 3);
  assert.equal(choisirTerrains(40, 3), 3);
  assert.equal(choisirTerrains(30, 2), 2);
  assert.equal(choisirTerrains(30, 1), 1);
  assert.equal(choisirTerrains(0, 3), 1);
});

test('équilibré : chacun placé une fois, tailles à 1 près, ≤ 6', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const n = 9 + (seed % 28);
    const C = choisirTerrains(n, 3);
    const r = generer({ joueurs: jeu(n, seed), terrains: C, mode: 'equilibre', rng: prng(seed) });
    const tous = [...r.equipes.flat(), ...r.nonPlaces];
    assert.equal(new Set(tous).size, n);
    assert.equal(tous.length, n);
    assert.equal(r.equipes.length, 2 * C);
    const tailles = r.equipes.map(t => t.length);
    assert.ok(Math.max(...tailles) - Math.min(...tailles) <= 1, `tailles ${tailles} n=${n}`);
    assert.ok(Math.max(...tailles) <= 6);
    assert.equal(r.nonPlaces.length, 0);
  }
});

test('équilibré : trois débutants jamais ensemble, un passeur par équipe quand possible', () => {
  let pb = 0, sansPasseur = 0, total = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const js = jeu(30, seed);
    const r = generer({ joueurs: js, terrains: 3, mode: 'equilibre', rng: prng(seed) });
    const par = new Map(js.map(j => [j.n, j]));
    for (const t of r.equipes) {
      total++;
      if (t.filter(n => par.get(n)!.niveau <= 1).length > 1) pb++;
      if (!t.some(n => par.get(n)!.passeur > 0)) sansPasseur++;
    }
  }
  assert.equal(pb, 0);
  assert.ok(sansPasseur / total < 0.15, `sans passeur ${sansPasseur}/${total}`);
});

test('équilibré : joueurs fixés respectés', () => {
  const js = jeu(20, 5);
  const r = generer({ joueurs: js, terrains: 2, mode: 'equilibre', fixes: { J4: 3, J5: 0 }, rng: prng(9) });
  assert.ok(r.equipes[3].includes('J4'));
  assert.ok(r.equipes[0].includes('J5'));
});

test('équilibré : trop de joueurs → remplaçants', () => {
  const r = generer({ joueurs: jeu(30, 2), terrains: 1, mode: 'equilibre', rng: prng(2) });
  assert.equal(r.equipes.flat().length, 12);
  assert.equal(r.nonPlaces.length, 18);
  assert.ok(r.avertissements.some(a => a.includes('remplaçant')));
});

test('compétition : terrain 1 Blocklieu contre AceCules, 4 par équipe', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const js = jeu(30, seed, { bleu: 6, ace: 5 });
    const r = generer({ joueurs: js, terrains: 3, mode: 'competition', rng: prng(seed) });
    const par = new Map(js.map(j => [j.n, j]));
    assert.equal(r.equipes[0].length, 4);
    assert.equal(r.equipes[1].length, 4);
    assert.ok(r.equipes[0].every(n => par.get(n)!.club === 'Blocklieu'));
    assert.ok(r.equipes[1].every(n => par.get(n)!.club === 'AceCules'));
    const tous = [...r.equipes.flat(), ...r.nonPlaces];
    assert.equal(new Set(tous).size, 30);
  }
});

test('compétition : groupe incomplet complété par des joueurs sans club', () => {
  const js = jeu(20, 3, { bleu: 5, ace: 2 });
  const r = generer({ joueurs: js, terrains: 2, mode: 'competition', rng: prng(3) });
  const par = new Map(js.map(j => [j.n, j]));
  assert.equal(r.equipes[0].length, 4);
  assert.equal(r.equipes[1].length, 4);
  assert.ok(r.equipes[1].filter(n => par.get(n)!.club === 'AceCules').length === 2);
  assert.ok(r.equipes[1].every(n => par.get(n)!.club !== 'Blocklieu'));
});

test('compétition : un seul terrain, les autres sont remplaçants', () => {
  const js = jeu(16, 4, { bleu: 5, ace: 5 });
  const r = generer({ joueurs: js, terrains: 1, mode: 'competition', rng: prng(4) });
  assert.equal(r.equipes.length, 2);
  assert.equal(r.nonPlaces.length, 8);
});

test('les avertissements ne contiennent ni nom ni niveau', () => {
  const js = jeu(9, 6);
  const r = generer({ joueurs: js, terrains: 2, mode: 'equilibre', rng: prng(6) });
  for (const a of r.avertissements) {
    assert.ok(!/J\d+/.test(a));
    assert.ok(!/niveau/i.test(a));
  }
});

test('noms en double refusés', () => {
  const j = jeu(4, 1);
  j[1].n = j[0].n;
  assert.throws(() => generer({ joueurs: j, terrains: 1, mode: 'equilibre' }));
});
