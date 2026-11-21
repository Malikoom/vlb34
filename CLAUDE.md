# Volley Loisir Beaulieu : site des entraînements

Mini site mobile first pour gérer les présences aux entraînements d'un club de volley loisir (46 membres).
Séances : mardi 12h-14h et jeudi 20h-22h, toujours au même lieu. Coach : Nico. Je suis le capitaine.

## Préférences de travail
- Je parle français : réponds en français.
- Gratuit uniquement (Supabase offre gratuite, GitHub Pages). Aucune dépendance payante.
- Mobile first. Thème clair/sombre automatique. Couleurs du club : bleu marine #173889, jaune #edc406.
- Je suis assez technique pour déboguer : explique brièvement les choix, sans sur-expliquer.
- Avant de pousser, vérifie la syntaxe JS du `<script>` et, si possible, teste dans un navigateur (surtout le glisser-déposer des équipes, au toucher).

## Architecture
- **Front** : un seul fichier `index.html` (HTML/CSS/JS natif, sans framework), publié sur GitHub Pages : https://malikoom.github.io/vlb34/
- **Back** : Supabase (Postgres). Aucune table n'est lisible directement avec la clé publique : RLS activée sans politique. Tout passe par des fonctions SQL `security definer` appelées en RPC (`/rest/v1/rpc/<fonction>`).
- **Admin ("mode Nico")** : un code partagé stocké dans la table `reglages` (clé `code_admin`), vérifié par `admin_ok()` dans chaque fonction `admin_*`. Un code faux ralentit de 0,7 s. Le cadenas du header bascule le mode Nico.
- **Identité joueur** : il choisit son prénom (liste avec recherche), mémorisé dans `localStorage`. Ce n'est pas une authentification.
- La clé `sb_publishable_…` dans `index.html` est publique par conception. Ne jamais mettre de clé `service_role`/secrète dans le dépôt, ni le code admin, ni les niveaux des joueurs.

## Base de données
Tables : `joueurs` (prenom, equipe Blocklieu/AceCules/null, actif), `profils` (joueur_id, niveau 1-4, genre 1/2, passeur 0/1/2 : CONFIDENTIEL, lu uniquement par l'Edge Function), `seances` (date, debut, fin, annulee, note, apero, equipes_match, composition jsonb), `reponses` (statut present/pas_sur/absent/match, apero_choix oui/non, apero_apporte), `presences` (présence réelle saisie par Nico), `invites` (attente/accepte/refuse), `actus` (titre, texte, url, image, date_evenement, epingle), `reglages`.

Migrations à lancer dans cet ordre dans Supabase > SQL Editor (vérifier lesquelles sont déjà passées) :
`schema.sql`, `migration_v2.sql`, `migration_v3_actus.sql`, `migration_v4_actus_liens.sql`, `migration_v5_actus_image.sql`, `migration_v6_apero.sql`, `migration_v7_equipes.sql`.
Quand une migration remplace une fonction RPC, pousser `index.html` seulement après l'avoir lancée.
Ces fichiers SQL sont dans `migrations/` (aucun secret). Le script d'import des profils (niveaux réels) n'est JAMAIS dans le dépôt.

## Edge Function `equipes` (supabase/functions/equipes)
- `moteur.ts` : moteur pur (tests : `node --experimental-strip-types --test supabase/functions/equipes/moteur.test.ts`, données synthétiques uniquement). `index.ts` : service Deno, actions `brouillon` (Nico, code admin, rien d'enregistré) et `auto` (joueur « Présent », seulement pendant la séance à l'heure de Paris, sans composition existante, écriture atomique `composition is null`, verrouillée).
- Déployée avec `verify_jwt = false` (`supabase/config.toml`) car la clé publique n'est pas un JWT ; elle contrôle elle-même l'accès. Utilise `SUPABASE_SERVICE_ROLE_KEY` (variable d'environnement de la fonction, jamais dans le dépôt).
- Les niveaux ne sortent jamais du serveur : la réponse ne contient que des noms et des avertissements génériques.
- Règles : équipes de 4 à 6 (3 si besoin), 2 équipes par terrain ; terrains = plus petit nombre ≤ max (mardi 1 ; jeudi 3, ou 2 si match) gardant ≤ 6 par équipe ; mode équilibré = un passeur par équipe, faibles et genres répartis, jamais 2 débutants ensemble ; mode compétition = terrain 1 Blocklieu contre AceCules à 4, groupe incomplet complété par des joueurs sans club.
- Quota gratuit ~500 000 appels/mois (à vérifier dans le tableau de bord Supabase).

## Fonctionnalités en place
- Onglets **Entraînements** et **Actus** sous le header « Volley Loisir Beaulieu » (logo `logo.jpg` à côté d'`index.html`).
- Réponses Présent / Pas sûr(e) / Absent / Match (re-tap = annuler). Bouton Match clignotant si l'équipe du joueur a un match ce jour-là.
- Accordéons : « Qui vient ? » (groupes avec icône), « Équipes du jour » (terrains visuels, nom du joueur surligné), bloc Apéro (replié une fois répondu).
- Apéro : coché par Nico par séance ; le joueur répond oui + ce qu'il apporte, ou non ; il ne modifie que sa propre ligne.
- Invités : un joueur demande (3 max par séance), Nico accepte/refuse ; les acceptés comptent comme présents.
- Mode Nico : séances à venir puis passées (accordéon), pastille jaune si invités à valider, création des séances sur une période, assiduité, composition des équipes en glisser-déposer (1 terrain le mardi ; 3 le jeudi, 2 s'il y a match) avec remplissage aléatoire équilibré (écart max 1 joueur entre équipes).
- Actus : titre, lien, date d'événement, texte, épinglage ; aperçu du lien (titre + image) via Microlink (gratuit, 25 requêtes/jour, bloqué par Facebook/Instagram).

## Pistes à venir
- Affinités / incompatibilités entre joueurs, bouton « Je suis arrivé » pour les retardataires.
- Mini-tournois, notifications (PWA), message WhatsApp prérempli pour Nico (`wa.me`), job GitHub Actions `keepalive.yml` contre la mise en pause de Supabase.
- WhatsApp : aucun envoi automatique dans le groupe existant n'est possible gratuitement ; seuls les liens `wa.me` préremplis fonctionnent.

## Pièges connus
- Les dates `AAAA-MM-JJ` des séances sont comparées à la date locale du navigateur (`ajd()`), pas à `toISOString()` (décalage UTC).
- Les équipes enregistrées sont visibles de tous les joueurs immédiatement : penser à les effacer après des essais.
- `localStorage` peut être bloqué (Safari) : toujours dans un try/catch.
