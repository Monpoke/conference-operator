# Cloud Nord — Régie de salle & Hub

Régie d'événement pour **Cloud Nord 2026** (30/10/2026, 3 salles) : projection des
slides, captation d'un master déjà habillé pour la VOD, streaming live, bascule
vers sponsors et programme entre les interventions, mur social.

Deux applications :

- **hub** (cloud) — importe le programme, diffuse salles et commandes, collecte les
  interactions sociales et la télémétrie ;
- **room-client** (Electron, un par salle) — pilote deux instances OBS, sert l'écran
  de salle, et **fonctionne seul** : réseau coupé, la régie continue et rien n'est perdu.

Plan d'architecture complet : `~/.claude/plans/je-voudrais-cr-er-une-validated-fountain.md`

## État

| Lot | Contenu | État |
|---|---|---|
| 0 | Fondations : monorepo, contrat, schémas, parseur programme | ✅ |
| 1 | Squelette bout-en-bout (hub + client + OBS-A) | ✅ |
| — | Fenêtre de régie (contrôles opérateur) | ✅ |
| 2 | Résilience : outbox/inbox, cache d'assets, horloge | ✅ |
| 3 | Chaîne OBS complète : OBS-B, VOD, sidecars, streaming | ✅ |
| 4 | Social : mur, Q&A, modération, console hub | ✅ |
| 5 | Exploitation : packaging, supervision, runbook | ✅ (répétition à faire) |

## Structure

```
packages/program    parseur/normaliseur de l'export « conference-center » + sélecteurs par salle
packages/contract   contrat oRPC v2 (zod) : procédures, événements, commandes
packages/db         schémas Drizzle + migrations (hub et client), helper SQLite
apps/hub-server     Fastify + oRPC + SQLite + Better Auth : programme, salles, commandes, appairage
apps/room-client    Electron — écran de salle, pilotage OBS, appairage, cache local
spikes/orpc-v2      spike jetable de validation des adapters — voir FINDINGS.md
                    plus les pages servies : /mur (public, QR), /admin (console)
```

## Démarrer

```bash
corepack enable && pnpm install
pnpm test            # 213 tests
pnpm typecheck
```

## Lancer en local

**1. Configurer le hub**

```bash
cd apps/hub-server
cp .env.example .env
# renseigner BETTER_AUTH_SECRET :
openssl rand -base64 48
```

**2. Créer un compte opérateur.** L'inscription publique est fermée : sans cette
étape, la console est inaccessible et personne ne peut appairer une machine.

```bash
pnpm --filter @cloudnord/hub-server operator regie@cloudnord.fr "Régie" <mot-de-passe>
```

**3. Lancer le hub**

```bash
pnpm --filter @cloudnord/hub-server dev
```

Au premier démarrage il importe le programme depuis `PROGRAM_SOURCE_URL` et
**crée les trois salles à partir de `event.tracks[]`**. La console est sur
<http://localhost:8787/admin>, le mur public sur
<http://localhost:8787/mur?salle=track-1-teilhard-de-chardin>.

**4. Lancer un client de salle**

Deux façons, selon qu'on a une interface graphique ou non.

**Sans Electron ni OBS** — recommandé pour développer, notamment sous WSL, en
conteneur ou sur une machine distante :

```bash
cd apps/room-client
HUB_ORIGIN=http://localhost:8787 HEURE_SIMULEE=2026-10-30T10:20:00Z pnpm dev:headless
```

Les pages s'ouvrent dans un navigateur : `/regie`, `/display/projector`,
`/display/overlay` sur le port affiché. Toute la logique du client vit hors
Electron, c'est ce qui rend ce mode possible.

**Avec Electron** :

```bash
HUB_ORIGIN=http://localhost:8787 OBS_MOCK=1 pnpm --filter @cloudnord/room-client dev
```

Dans les deux cas, le client affiche un **code d'appairage** : le saisir dans la
console (« Machines en attente »), choisir une salle, approuver.

### Réglages du mode local

| Variable | Effet |
|---|---|
| `CLOCK_CONTROL=1` **(sur le hub)** | Ouvre le réglage de l'heure depuis la console (onglet Réglages) : sélecteur de date, raccourcis vers les moments clés, retour à l'heure réelle. Les salles se réalignent aussitôt. **Fermé par défaut** — le faire pendant l'événement fausserait les timecodes des enregistrements. |
| `SIMULATED_TIME` **(sur le hub)** | Place **tout le système** à un instant de l'événement. Les salles s'alignent sur `serverTime`, il n'y a rien à régler de leur côté. C'est la bonne façon de dérouler la journée du 30/10 dès maintenant. |
| `HEURE_SIMULEE` (sur la salle) | Heure locale, pour développer **sans hub**. Dès qu'un hub répond, son heure l'emporte. Régler les deux les ferait diverger — et tout ce qui les compare, comme l'obsolescence d'une commande, se mettrait à mentir. |
| `OBS_MOCK=1` / `dev:headless` | OBS simulé : scènes, enregistrement, diffusion. Écrit un **vrai fichier** à l'arrêt, donc la chaîne VOD va jusqu'au sidecar. |
| `OBS_REEL=1` | En headless, parle à un vrai OBS plutôt qu'au simulé. |
| `DISPLAY_PORT` | Port du serveur local (défaut 7788). |

Un talk complet avec OBS simulé produit exactement ce qu'il produirait en salle :

```
2026-10-30_track-1-teilhard_1100_honeyswamp-active-defense-to-ruin-attackers.mkv
2026-10-30_track-1-teilhard_1100_honeyswamp-active-defense-to-ruin-attackers.json
   titre     : HoneySwamp: Active Defense to Ruin Attackers
   speakers  : Steven LE ROUX
   catégorie : Sécurité
   marqueurs : ['début de la démo']
```

### Sous WSL

Les erreurs `dbus` d'Electron sont du bruit sans conséquence. L'avertissement
« Chiffrement indisponible — jeton stocké en clair » est attendu : il n'y a pas
de trousseau système, et l'application le dit plutôt que de le taire. Si aucune
fenêtre ne s'ouvre (pas de serveur X), utiliser `dev:headless`.

**Voir les pages sans rien lancer** :

```bash
pnpm --filter @cloudnord/room-client preview ./apercu
```

Rejouer le spike de validation oRPC :

```bash
pnpm --filter @cloudnord/spike-orpc-v2 spike     # 8/8 attendus
```

Régénérer les migrations après modification d'un schéma :

```bash
pnpm --filter @cloudnord/db generate:hub
pnpm --filter @cloudnord/db generate:client
```

## Voir l'écran de salle

```bash
pnpm --filter @cloudnord/room-client preview ./apercu
```

Génère les pages réelles — écran de salle dans ses quatre modes, habillage de
captation, fenêtre de régie — avec les vraies données de l'événement.

Le client sert trois surfaces sur son serveur local :

| URL | Usage |
|---|---|
| `/display/projector` | Browser Source d'OBS-A, ou fenêtre plein écran de secours |
| `/display/overlay` | Browser Source transparente d'OBS-B (habillage VOD) |
| `/regie` | Fenêtre de l'opérateur : scènes, enregistrement, marqueurs, diagnostic |

## Décisions structurantes

- **`event.tracks[]` de l'export amont = les salles.** Le programme d'une salle est
  un simple filtre `session.trackId === room.trackId`.
- **Peu de scènes OBS, un écran piloté par le web.** OBS-A n'a que `LIVE` (capture
  HDMI) et `HOLD` (une Browser Source). Sponsors, programme, compte à rebours et
  messages sont rendus par la page, pas par des scènes — changer de contenu ne
  demande jamais de toucher à OBS.
- **SQLite des deux côtés, instance hub unique.** Supprime Redis (fanout WebSocket
  en process), partage un seul ORM, et rend les tests exécutables sans conteneur.
- **oRPC v2 contract-first**, un contrat pour trois transports : HTTP, WebSocket,
  MessagePort/Electron. Version **épinglée** (beta) ; doc de référence `v2.orpc.dev`.
- **Le client n'est pas « en mode dégradé », il est autonome par défaut.** Aucune
  action de régie ne bloque sur le réseau : `emit()` écrit dans une file SQLite
  locale, la remontée se fait en tâche de fond.
- **Deux politiques de livraison, déduites du type d'événement.** `required`
  (enregistrements, marqueurs, scènes) rejoué 48 h ; `best-effort` (télémétrie)
  périmé en 30 s et collapsé par clé — une heure hors ligne laisse *un* heartbeat
  en file, pas 720.
- **Une machine de salle a ses propres droits, pas ceux d'un opérateur.** Le flux
  device authorization prouve qu'un opérateur a approuvé la machine ; elle échange
  aussitôt cette session contre un **jeton de salle** (`rt_…`, stocké haché côté
  hub) qui ne permet que sync, remontée, lecture de l'état des salles et cycle de
  vie de *ses* conférences. Ni import de programme, ni modération, ni appairage,
  ni réglages.
- **Un hub absent au démarrage ne condamne pas la salle.** Une boucle de
  supervision sonde le hub toutes les 15 s et rattrape ce qui a échoué :
  appairage, connexion, OBS. C'est l'ordre de démarrage le plus probable un matin
  d'événement — les salles s'allument avant que quiconque ait lancé le hub.
- **Une coupure passagère ne périme pas un code d'appairage.** Le sondage
  continue jusqu'à l'expiration réelle du code : perdre le code parce que le hub
  a redémarré obligerait l'opérateur à tout recommencer sans raison.
- **La salle se choisit sur l'écran de régie**, au premier démarrage. Le choix
  voyage dans le `scope` de la demande d'appairage ; la console le retrouve
  **pré-sélectionné**, tout en restant libre d'en changer. C'est l'opérateur de
  la salle qui sait où il se trouve, celui devant la console qui tranche.
  `ROOM_ID=<id>` court-circuite l'écran pour un poste provisionné d'avance.
- **Un jeton refusé relance l'appairage** au lieu de boucler : la régie affiche un
  écran avec le code à saisir dans la console, qui disparaît à l'approbation.
- **Le JavaScript des pages est analysé par un test.** Il vit dans un template
  literal, où TypeScript ne voit qu'une chaîne : une apostrophe mal échappée y
  casse *toute* la page sans que rien ne proteste. Chaque page est parsée, et
  les comportements clés (onglets, menus, boutons) sont testés dans un DOM réel
  via happy-dom. C'est le prix de l'absence d'étape de build, et il se paie une fois.
- **Les trois pages sont autonomes et sans étape de build.** Écran, overlay et
  régie s'ouvrent même quand tout le reste va mal, et se testent en HTTP. Le
  contrat oRPC sur MessagePort prévu au plan reste disponible le jour où une UI
  plus riche justifiera un bundler.
- **Le chemin du fichier enregistré ne se connaît qu'après `StopRecord`.** OBS ne
  l'annonce que dans l'événement `RecordStateChanged` qui suit l'arrêt, et il faut
  armer l'attente *avant* de demander l'arrêt. Le lire avant donne toujours `null`
  — et aucun sidecar ne serait jamais écrit.
- **Trois états réseau, pas deux.** `OFFLINE` (rien ne répond) et `DEGRADED` (le
  hub répond en HTTP mais le temps réel est tombé) n'appellent pas la même
  réaction en régie. On ne se fie jamais à `navigator.onLine`, qui ne dit rien de
  l'accessibilité du hub.
- **Better Auth** : opérateurs par e-mail, machines de salle par *device authorization*
  (RFC 8628). Better Auth lie l'appareil à l'opérateur qui approuve ; l'affectation
  machine → salle est à nous (`room_device`), ce qui rend la révocation indépendante
  des comptes.
- **L'écran est servi avant tout appel réseau.** `RoomApp.startDisplay()` précède
  l'appairage et la synchronisation : une salle projette son programme même si le
  hub n'a jamais répondu.
- **SSE, pas WebSocket, pour l'écran projeté.** Le navigateur reconnecte un
  `EventSource` sans une ligne de code — la propriété qu'on veut sur la seule page
  qui ne doit jamais rester figée. Le flux est unidirectionnel de toute façon.
- **Toute la logique du client vit dans `src/core/`, sans dépendance à Electron**,
  ce qui permet de tester la chaîne réelle (appairage, OBS, écran) sans écran ni
  instance OBS. `src/main/` n'est que l'ouverture des fenêtres.

## Surfaces servies

| Servi par | URL | Usage |
|---|---|---|
| hub | `/admin` | Console : modération, appairage, programme, supervision |
| hub | `/admin/devices?user_code=…` | Même console, code d'appairage pré-rempli (lien affiché par la régie) |
| hub | `/mur?salle=<id>` | Mur public et questions, scanné au QR |
| client | `/regie` | Fenêtre opérateur |
| client | `/display/projector` | Browser Source OBS-A, ou plein écran de secours |
| client | `/display/overlay` | Browser Source transparente OBS-B |

## Empaqueter le client de salle

```bash
pnpm --filter @cloudnord/room-client package:win
```

Bundle esbuild du processus principal puis electron-builder (NSIS x64). Les
migrations du schéma local voyagent dans `resources/` — le client les y cherche
en priorité, et retombe sur le monorepo en développement.

⚠️ Sans signature de code, SmartScreen avertira au premier lancement : installer
les machines **avant** le jour J, pas devant une salle qui attend.

## Arrêt du hub

`pnpm dev` utilise **`node --watch`**, pas `tsx watch`. Ce n'est pas un détail de
confort : `tsx watch` tue son processus enfant sans lui laisser exécuter le
moindre gestionnaire de signal — ni au Ctrl-C, ni à chaque sauvegarde de
fichier. La base n'était donc jamais refermée, ce que trahissent des `hub.db-wal`
et `hub.db-shm` résiduels.

L'arrêt se fait à deux niveaux : gracieux sur SIGINT/SIGTERM (draine les
requêtes, coupe les WebSockets, referme la base), avec une **échéance de 5 s**,
doublé d'un filet **synchrone** sur `exit` — les gestionnaires `exit` de Node
n'attendent aucune promesse. `SIGKILL` reste hors de portée, et c'est
précisément ce pour quoi le mode WAL de SQLite existe.

## Écran de régie

L'écran de l'opérateur tient dans une fenêtre, **sans ascenseur** : les
commandes ne défilent pas. Un bouton sous la ligne de flottaison est un bouton
qu'on ne trouve pas au moment où on en a besoin — et c'était le cas de
l'enregistrement et de la diffusion sur un écran de 720 px.

Ce qui reste visible en permanence est ce qui déclenche une décision :

- le **temps restant** au créneau, à la seconde, qui vire à l'alerte en
  dépassement — pas le temps écoulé depuis le début réel, mais l'écart au
  programme, puisque c'est lui qui décale la suite de la journée ;
- la **conférence suivante**, qui dit si on peut laisser filer cinq minutes ;
- le **flux des autres salles**, une ligne : conférence en cours, « vers la fin »
  dans les cinq dernières minutes, reprise après une pause. Il est calculé sur
  le programme mis en cache localement, pas sur l'état remonté par le hub :
  pendant une coupure, la salle d'à côté finit quand même à l'heure prévue.

Ce qui se consulte — programme complet de la salle, programme d'une autre
salle, état des salles vu du hub — passe en **modale**, à un clic ou aux
touches `P` et `S`, `Échap` pour refermer. Les commandes et les raccourcis
restent actifs modale ouverte : une conférence ne s'arrête pas parce qu'on
consulte le programme.

Sur un écran court (moins de 700 px de haut), une règle de densité resserre
panneaux et boutons plutôt que de laisser sortir une commande. Au-dessous de
1024 px de large, la grille retombe sur une colonne défilante — faute de mieux.

## Niveaux audio en régie

Le panneau « Niveaux audio » de la régie affiche les vumètres des entrées
d'OBS-B, en dBFS, avec maintien de crête.

Deux propriétés qui expliquent la forme :

- **Abonnement à la demande.** `InputVolumeMeters` n'est pas dans le jeu
  d'événements par défaut d'OBS, et pour cause : il émet une cinquantaine de
  fois par seconde, sur la machine qui encode. La salle ne s'y abonne que tant
  qu'au moins une régie affiche le panneau, et s'en détache à la fermeture.
- **Flux séparé de l'état.** `/display/audio`, à 10 Hz. Passer les niveaux par
  la charge utile d'état republierait tout le programme cent fois plus souvent
  que nécessaire — mesuré : le flux d'état reste à un seul message pendant que
  196 mesures audio circulent.

L'agrégation entre deux envois se fait **en maximum, pas par échantillonnage** :
une saturation d'un dixième de seconde doit rester visible, c'est même la seule
raison de regarder un vumètre.

Le mode OBS simulé produit trois entrées plausibles (micro, ambiance, retour
muet), ce qui rend le panneau observable sans salle ni carte son.

## Habillage (Tailwind)

Les six pages servies — écran de salle, habillage captation, régie, console du
hub, machines en attente, mur public — utilisent Tailwind v4, **sans étape de
build à l'exécution**. La feuille est compilée dans `packages/ui` et figée dans
un module TypeScript, que chaque page inline dans un `<style>` :

```bash
pnpm --filter @cloudnord/ui build      # après avoir ajouté des classes
```

Trois raisons à ce détour plutôt qu'un `<link>` ou un CDN : une page doit
s'ouvrir sans réseau (c'est précisément quand tout va mal qu'on en a besoin), un
fichier lu sur disque ne survivrait pas à l'empaquetage Electron, et une
constante inlinée dans le bundle ne peut pas manquer à l'appel.

**Trois pièges rencontrés, tous verrouillés par un test :**

- *La feuille peut être périmée.* Une classe ajoutée dans une page sans
  recompiler n'a aucun style, et rien ne le signale. `packages/ui` recompile
  pendant ses tests et compare — c'est exact, pas un échantillonnage.
- *Tailwind scannait sa propre sortie.* La détection automatique balaie tout le
  dépôt, y compris le CSS généré, qui contient tous les noms de classes : la
  compilation n'était pas reproductible. D'où `source(none)` et des `@source`
  explicites.
- *happy-dom ignore `@layer`*, où vit toute la sortie Tailwind. Sans
  `aplatirCouchesHtml` (exporté par `@cloudnord/ui`), les tests de visibilité
  effective — ceux qui ont attrapé le défaut des onglets — cesseraient
  silencieusement de vérifier quoi que ce soit.

Aperçus statiques, sans rien démarrer :

```bash
pnpm --filter @cloudnord/room-client preview <dossier>   # salle, habillage, régie
pnpm --filter @cloudnord/hub-server  preview <dossier>   # console, mur
```

## Base bloquée après une mise à jour du schéma

Si le hub refuse de démarrer en disant qu'il ne reconnaît pas les migrations,
**le problème est presque toujours dans les fichiers, pas dans la base** : une
migration déjà appliquée a été régénérée, donc son empreinte a changé. La base,
elle, contient les comptes opérateurs, les appairages et la modération du jour.

```bash
git checkout -- packages/db/migrations   # restaure les migrations publiées
```

Si le schéma a réellement évolué, la migration s'**ajoute** :

```bash
pnpm --filter @cloudnord/db generate:hub
pnpm --filter @cloudnord/db sceller
```

Le sceau (`migrations/<jeu>/empreintes.json`) est vérifié par les tests : une
ligne de base régénérée fait échouer le build au lieu de casser une base au
démarrage. Supprimer `apps/hub-server/data` reste un dernier recours, réservé à
une base jetable. Détails : `packages/db/MIGRATIONS.md`.

## Procédures de salle

`apps/room-client/RUNBOOK.md` — à imprimer et poser à côté du PC de régie.

## Lancer le hub

```bash
cp apps/hub-server/.env.example apps/hub-server/.env
# renseigner BETTER_AUTH_SECRET : openssl rand -base64 48
pnpm --filter @cloudnord/hub-server dev
```
