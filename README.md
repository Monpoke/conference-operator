# Cloud Nord — Régie de salle & Hub

Régie d'événement pour **Cloud Nord 2026** (30/10/2026, 3 salles) : projection des
slides, captation d'un master déjà habillé pour la VOD, streaming live, bascule
vers sponsors et programme entre les interventions, mur social.

Deux applications :

- **hub** (cloud) — importe le programme, diffuse salles et commandes, collecte les
  interactions sociales et la télémétrie ;
- **room-client** (Electron, un par salle) — pilote deux instances OBS, sert l'écran
  de salle, et **fonctionne seul** : réseau coupé, la régie continue et rien n'est perdu.

La structure du dépôt est décrite plus bas, et les choix qui ne se devinent pas
à la lecture du code sont réunis dans « Décisions structurantes ». Pour
contribuer : [CONTRIBUTING.md](CONTRIBUTING.md).

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

**Ce compte reste nécessaire même avec Google** (ci-dessous) : Google exige
internet au moment de la connexion, et tout ce système est bâti pour survivre à
une coupure. Un hub qui ne s'ouvre que par Google enferme l'équipe dehors
exactement le matin où le réseau tombe.

### Connexion Google Workspace

Facultative, et **tout compte du domaine autorisé est un opérateur** — c'est
l'annuaire qui fait la liste, personne n'a de compte à provisionner le matin de
l'événement.

Dans la console Google Cloud : un client OAuth « Application Web », avec
`<PUBLIC_URL>/api/auth/callback/google` en URI de redirection autorisée (plus
`http://localhost:8787/api/auth/callback/google` pour le développement — Google
n'accepte `http` que sur localhost). Écran de consentement en **Internal** si le
domaine est bien un Workspace : c'est une barrière de plus, gratuite.

Puis dans le `.env` du hub :

```bash
GOOGLE_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=…
GOOGLE_HOSTED_DOMAIN=cloudnord.fr
```

Le domaine est **envoyé à Google comme indice `hd` *et* revérifié contre la
revendication du jeton d'identité** au retour. L'indice seul ne serait qu'une
préférence d'écran de choix de compte, qu'un compte personnel contourne ; c'est
la seconde vérification qui tient la frontière.

Les deux identifiants vont par paire : n'en renseigner qu'un **empêche le hub de
démarrer**, plutôt que de monter une console dont le bouton échoue à chaque clic.
Le bouton n'apparaît que si le hub sait s'en servir, et le mot de passe reste
au-dessus, toujours.

**3. Lancer le hub**

```bash
pnpm --filter @cloudnord/hub-server dev
```

Au premier démarrage il importe le programme depuis `PROGRAM_SOURCE_URL` et
**crée les trois salles à partir de `event.tracks[]`**. Cette variable n'amorce
que la première fois : l'URL devient ensuite le réglage « Source du programme »
de la console, modifiable sans redémarrer et utilisé par « Réimporter ». La console est sur
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
MODE=dev HUB_ORIGIN=http://localhost:8787 pnpm --filter @cloudnord/room-client dev
```

Dans les deux cas, le client affiche un **code d'appairage** : le saisir dans la
console (« Machines en attente »), choisir une salle, approuver.

### `MODE=dev` : les commodités de développement

**Un seul interrupteur par côté**, hub et salle, et c'est lui qui commande tout
le reste. Le défaut est `production` — le défaut doit être le cas dangereux, pas
le cas confortable.

**Les deux applications, deux terminaux** — la façon recommandée, et la seule
qui marche sous WSL sans serveur X :

```bash
# 1 — le hub
MODE=dev pnpm --filter @cloudnord/hub-server dev

# 2 — une salle, sans Electron ni OBS
HUB_ORIGIN=http://localhost:8787 pnpm --filter @cloudnord/room-client dev:headless
```

`dev:headless` se met de lui-même en `MODE=dev` : c'est ce qu'il sert à faire.
Avec Electron, à la place du second terminal :

```bash
MODE=dev HUB_ORIGIN=http://localhost:8787 pnpm --filter @cloudnord/room-client dev
```

**Ou les deux d'un coup**, depuis la racine — turbo lance le hub *et* le client
Electron :

```bash
MODE=dev pnpm dev
```

Deux choses à savoir sur cette forme. Turbo 2 filtre l'environnement des tâches
(mode « strict ») : les variables de développement sont donc déclarées en
`passThroughEnv` dans `turbo.json`, sans quoi `MODE=dev` n'atteindrait aucune
des deux applications et les deux démarreraient en production **sans un mot**.
Et le client lancé est celui d'Electron : sous WSL sans serveur X, aucune
fenêtre ne s'ouvre — les deux terminaux ci-dessus valent mieux.

Une variable posée sur la ligne de commande l'emporte sur le `.env` : garder
`MODE=production` dans `apps/hub-server/.env` n'empêche pas `MODE=dev pnpm …`
de fonctionner.

**Le hub et les salles d'un seul terminal**, sans Electron :

```bash
pnpm dev:duo    # hub + une salle   (7788)
pnpm dev:trio   # hub + deux salles (7788 et 7789)
```

Une salle suffit pour développer une régie. Il en faut deux dès qu'on touche à
ce qui est commun à l'événement — le mur des questions, un message poussé depuis
la console, la modération : ces bugs-là ne se voient pas à une salle.

Chaque salle a son `DATA_DIR`, donc sa propre identité machine, et son
`ROOM_ID`, ce qui évite l'écran de choix de salle : elles affichent directement
leur code d'appairage. `HUB_ORIGIN`, `SALLE_1`, `SALLE_2`, `PORT_1` et `PORT_2`
restent réglables. Ctrl-C arrête tout le monde, en laissant au hub le temps de
refermer sa base (voir « Arrêt du hub »).

**Pour dérouler la journée du 30 octobre**, ajouter l'heure sur le hub — les
salles s'alignent, il n'y a rien à régler de leur côté :

```bash
MODE=dev SIMULATED_TIME=2026-10-30T10:20:00Z pnpm --filter @cloudnord/hub-server dev
```

Hors de ce mode, les réglages ci-dessous sont **neutralisés même s'ils sont
renseignés**, et chaque poste le dit bruyamment : journal en erreur, bandeau
rouge dans la console du hub. Ils ne font pas échouer le démarrage — un hub qui
refuse de repartir en cours d'événement parce qu'une ligne traîne dans un
`.env` serait pire que le mal qu'on soigne. C'est là tout l'intérêt : un
`OBS_MOCK=1` oublié dans un raccourci, c'est une journée entière filmée par une
instance OBS qui n'existe pas, et la panne se découvre au montage.

| Variable | Côté | Effet, **en `MODE=dev` seulement** |
|---|---|---|
| `SIMULATED_TIME` | hub | Place **tout le système** à un instant de l'événement. Les salles s'alignent sur `serverTime`, il n'y a rien à régler de leur côté. C'est la bonne façon de dérouler la journée du 30/10 dès maintenant. |
| *(par le mode)* | hub | Le **réglage de l'heure depuis la console** (onglet Réglages) : sélecteur de date, raccourcis vers les moments clés, retour à l'heure réelle. Ouvert en dev, fermé en production. |
| `HEURE_SIMULEE` | salle | Heure locale, pour développer **sans hub**. Posée comme un *décalage* sur l'horloge machine, exactement comme le fera le hub : dès qu'il répond, son heure remplace la valeur, sans que les deux se cumulent. Pour dérouler une journée, préférer `SIMULATED_TIME` sur le hub — les salles s'alignent seules. |
| *(par le mode)* | salle | **OBS est simulé** : scènes, enregistrement, diffusion. Écrit un **vrai fichier** à l'arrêt, donc la chaîne VOD va jusqu'au sidecar. `OBS_REEL=1` parle à de vraies instances à la place. |

**Deux variables ont disparu** : `CLOCK_CONTROL` et `OBS_MOCK`. Chacune
doublait le mode par un second interrupteur, ce qui laissait exister des
combinaisons absurdes — un hub de production dont on pouvait quand même
déplacer l'horloge. Les trouver dans un `.env` ou un raccourci ne fait plus
rien, et chaque poste le dit en nommant son remplaçant : le silence est ce
qu'on cherche à éviter, pas la variable.

Les réglages qui n'ont rien de dangereux restent libres : `DISPLAY_PORT` (port
du serveur local, défaut 7788), `DATA_DIR`, `ROOM_ID`, `HUB_ORIGIN`.

**Les deux côtés se surveillent.** Le hub annonce son mode à chaque `sync` ; la
salle le compare au sien et affiche un badge en régie : `MODE DEV` en ambre
quand tout le monde est d'accord, **`DEV · HUB EN PRODUCTION`** en rouge sinon.
Une salle de développement branchée sur le hub de l'événement enverrait de
vraies commandes depuis un poste qui simule tout — c'est exactement ce qu'on
veut voir de loin. La console du hub porte le même badge, rendu côté serveur.

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
| `/display/overlay` | Browser Source transparente d'OBS-B (habillage VOD, question du public) |
| `/display/overlay-live` | Browser Source transparente d'OBS-A — question du public et messages de la console |
| `/regie` | Fenêtre de l'opérateur : scènes, enregistrement, marqueurs, diagnostic |

## L'écran d'attente : une boucle

`loop` est le mode d'écran par défaut d'une salle — celui qu'on veut y trouver
le matin sans que personne n'ait rien touché, et celui sur lequel on retombe
quand un message s'efface. Il enchaîne quatre pages :

| Page | Durée | Ce qu'elle apporte |
|---|---|---|
| Nos partenaires | 12 s | Le palier de tête en grand, les autres engagements dessous |
| Programme de la salle | 15 s | La journée, du créneau en cours vers la suite |
| Pendant ce temps, à côté | 12 s | Le talk en cours ou à venir des **autres** salles |
| Suivez Cloud Nord | 10 s | Les comptes de l'événement, handle en grand |

Un cycle complet fait 49 secondes. Les durées ne sont pas égales : un programme
de vingt-sept lignes se lit, une rangée de logos se regarde. Elles sont
volontairement longues — un écran qui change toutes les trois secondes attire
l'œil pendant une pause où les gens se parlent. Les points en bas disent qu'il y
a une suite, et qu'elle tourne : sans eux, un écran qui change tout seul se lit
comme un écran instable. Le point actif se remplit sur la durée de la page, ce
qui dit en plus *quand* elle va tourner.

**Les partenaires sont en podium.** Le premier palier — celui qui a payé le
plus cher, et les paliers arrivent déjà triés par rang — occupe seul un bandeau
doré en haut de l'écran, logos au plus grand. L'or ne vient pas du thème de
l'événement, et c'est voulu : la marque habille l'écran, l'or dit le rang. Tant
que le bandeau reprenait la couleur de marque, le palier de tête se lisait comme
un encadré de plus. Il se déclenche sur le **rang**, jamais sur le nom du
palier : « Gold » peut devenir « Platine » d'une édition à l'autre, le premier
reste le premier. Tout le reste est fondu en une rangée
où chaque sponsor n'apparaît **qu'une fois**, avec la liste des packs qu'il a
pris ; ceux qui s'en sont offert plusieurs y ont une carte plus large, encadrée
de la couleur de marque, sous l'intitulé « Et sur tous les fronts ».

La hiérarchie est portée par le cadre, jamais par la taille du logo : dans une
rangée, toutes les pastilles partagent la même hauteur et la même ligne, et
toutes les légendes le même appui. Faire maigrir le logo de celui qui n'a pris
qu'un pack cassait la ligne — une rangée de partenaires se lit comme une
étagère, ou ne se lit pas.

**Les logos sont détourés à l'affichage.** Les sponsors déposent ce qu'ils
veulent : certains fichiers sont cadrés au plus près, d'autres laissent flotter
la marque au milieu d'une grande marge. Posés côte à côte à hauteur égale, les
seconds paraissent deux fois plus petits — c'est du vide qu'on affiche à leur
place. La page mesure donc l'encre de chaque logo et recadre dessus, une fois
par image, gardée ensuite en mémoire.

Deux garde-fous. Seules les marges **transparentes ou blanches** sont rognées :
un logo posé sur un aplat de couleur — le carré bleu d'AXA — a cet aplat pour
marque, et le resserrer sur le texte qu'il contient l'abîmerait. Et le calcul
n'est possible que parce que les images du cache sont servies par le client
lui-même sur `/assets` : un logo encore distant invalide le canvas, la lecture
lève, et l'image est gardée telle quelle.

Le dédoublonnage ne peut pas passer par l'identifiant : l'export amont en donne
un **par palier**, si bien qu'un même partenaire en porte autant que de packs
pris. C'est le site qui sert de clé, à la barre finale près, et le nom en repli.
Sans cela le même logo revenait à l'identique à trois lignes d'écart — projeté,
cela se lit comme un défaut d'affichage, pas comme de la générosité.

**Elle est animée, sobrement.** Deux pages se croisent en fondu — la sortante
s'efface par-dessus la nouvelle qui entre — les listes arrivent ligne à ligne
plutôt que d'un bloc, le programme part du créneau en cours et glisse vers la
suite de la journée pendant qu'il est affiché, et le halo de marque dérive en
quarante-quatre secondes derrière tout cela. Rien de tout ceci n'anime autre
chose qu'`opacity` et `transform` : ce sont les deux propriétés qu'un
compositeur traite sans repasser par la mise en page, seule façon de tenir dans
une Browser Source OBS en 4K. Un écran de pause parfaitement immobile pendant
vingt minutes finit par se lire comme un poste éteint sur une image.

**Une page sans contenu est sautée, pas affichée vide** : dix secondes de cadre
désert devant la salle se lisent comme une panne. Une salle jamais synchronisée
se réduit donc aux sponsors, exactement comme avant.

Les modes `sponsors` et `programme` restent disponibles seuls : quand quelque
chose se passe, on veut pouvoir figer l'écran sur une page précise plutôt que
d'attendre que la boucle y revienne.

### Ce qui alimente les deux pages nouvelles

**Les autres salles** sont calculées par la salle elle-même, sur le programme
déjà en cache et l'horloge corrigée du hub — jamais sur l'heure du poste, qui
peut en être à des semaines quand le hub tourne sur une horloge simulée. Aucun
appel réseau : la boucle tourne pendant les pauses, c'est-à-dire quand le réseau
de l'événement est le plus chargé. Les pauses des autres salles sont écartées —
« Déjeuner en Track #2 » n'aide personne à choisir où aller.

**Les comptes Cloud Nord** sont un réglage du hub (console, onglet *Réglages*,
panneau « Nos réseaux »), poussé aux salles au `sync` et **mis en cache local**
comme le programme. L'export amont ne porte que les réseaux des *speakers* :
ceux de l'événement n'ont aucune source, et corriger un handle ne doit pas
demander de rejouer une release sur les trois machines de salle.

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
- **Better Auth** : opérateurs par e-mail **ou par Google Workspace**, machines de
  salle par *device authorization* (RFC 8628). Better Auth lie l'appareil à l'opérateur qui approuve ; l'affectation
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
| hub | `/admin` | Console : supervision. Un onglet par adresse — `/admin/moderation`, `/admin/conferences`, `/admin/appairage`, `/admin/messages`, `/admin/reglages` |
| hub | `/admin/devices?user_code=…` | L'onglet Appairage, code pré-rempli (lien affiché par la régie) et verdict du code en modale |
| hub | `/mur?salle=<id>` | Mur public (commun à l'événement) et questions de la salle, scanné au QR |
| client | `/regie` | Fenêtre opérateur |
| client | `/display/projector` | Browser Source OBS-A, ou plein écran de secours |
| client | `/display/overlay` | Browser Source transparente OBS-B : titrage **et question du public** |
| client | `/display/overlay-live` | Bandeau live d'OBS-A : question du public et messages de la console |

## Appairer une machine

**Chaque onglet est une adresse.** La console rafraîchie rouvre l'onglet qu'on
regardait, un onglet se met en favori ou s'envoie à un collègue, et le bouton
Retour revient sur le précédent au lieu de quitter la console. Le hub sert la
liste des vues, pas un joker : `/admin/moderationn` répond 404 plutôt que
d'ouvrir l'exploitation en laissant croire à l'adresse.

L'appairage a sa **page dédiée** dans la console, onglet **Appairage** :
machines en attente avec leur code, et machines déjà liées. Le geste n'a lieu
qu'à la mise en route et demande de l'attention — se tromper de salle envoie les
commandes au mauvais vidéoprojecteur —, alors que la supervision se regarde
toute la journée : les mêler noyait l'un dans l'autre.

L'adresse que la machine affiche (`/admin/devices?user_code=…`) ouvre
directement cette page, code pré-rempli — et une **modale tranche sur ce
code-là** avant qu'on cherche la machine dans la file : valide, inconnu, expiré,
ou déjà traité. Quand il est valide, **elle porte la décision** : la salle
demandée pré-sélectionnée, Approuver, Refuser. Renvoyer vers la liste faisait
chercher la bonne ligne pour refaire le geste qu'on venait de valider des yeux. La file d'à côté ne dit rien du
code qu'on tient : trois autres machines peuvent y attendre pendant que
celui-ci est mort, et un code inconnu ne se corrige pas comme un code expiré —
l'un se recopie, l'autre se redemande depuis la régie.

Un détail qui compte à deux opérateurs : **consulter un code le réserve**.
Better Auth le rattache à la session qui le regarde — c'est ce que fait la
modale —, et un second opérateur ne pourra plus l'approuver depuis son poste.
La console le dit alors en clair, au lieu du refus anglais du plugin.

**Les demandes s'effacent seules.** Une demande vit le temps de son code
(`DEVICE_CODE_TTL`, **2 min** par défaut) et part avec un refus. Sans quoi la file
n'accumulait que des fantômes : une salle réinstallée revient sous une nouvelle
identité machine, et l'ancienne y restait indéfiniment. En développement, où
chaque `DATA_DIR` neuf produit une machine de plus, la file se vide toute
seule. Rien n'est perdu quand un code expire : la boucle de supervision en
redemande un sous 15 s et la régie affiche le nouveau.

⚠️ **Le jour J, poser `DEVICE_CODE_TTL=30m`.** Deux minutes, c'est le temps de
traverser une salle : l'opérateur qui recopie le code sur l'écran de régie et
marche jusqu'à la console peut arriver après sa mort. La modale le dira, mais
c'est un aller-retour de perdu — et il se paie devant une salle qui attend.

## Superviser depuis un téléphone

L'onglet **Exploitation** de la console liste les salles en **cartes** et non en
tableau : la supervision se regarde debout, au fond d'une salle, et sept
colonnes y deviennent illisibles. Chaque carte porte la connectivité, **ce qui
se joue en ce moment** — le titre, calculé sur le programme, donc juste même
quand la salle est coupée —, l'enregistrement, la diffusion, la scène, la file
en attente, et un lien vers le mur public de la salle.

La grille se replie d'elle-même : trois cartes de front sur un écran de bureau,
une seule sur un téléphone. L'en-tête et les onglets passent à la ligne plutôt
que de déborder.

### Être prévenu sans regarder

Un bouton **Notifications** dans l'en-tête. La console se consulte debout, dans
un couloir, entre deux salles : ce qui compte est d'apprendre qu'une salle
déborde sans avoir la page sous les yeux.

**Deux familles, trois crans chacune**, réglées séparément dans le panneau du
bouton. Elles ne s'adressent pas au même moment : l'une inquiète, l'autre
rythme.

| | **Rien** | **Essentiel** (défaut) | **Tout** |
|---|---|---|---|
| **Technique** — les machines | — | salle qui ne répond plus · machine en attente d'appairage | + salle revenue |
| **Exploitation** — le déroulé | — | dépassement · retard au démarrage | + conférence commencée · terminée · fin dans 5 min |

La ligne de partage : « essentiel » ne contient que **les écarts au script**,
ce qui demande un arbitrage. « Tout » ajoute le rythme normal de la journée.
Trois crans plutôt qu'un interrupteur parce que le volume le commande — sur
l'export 2026, 21 talks font **63 avis** rien qu'en débuts, fins et fins
proches, et un téléphone qui vibre soixante-trois fois finit en silencieux,
dépassements compris.

Le réglage vit **par appareil**, pas par opérateur : c'est la même personne qui
veut l'essentiel sur le téléphone dans sa poche et tout sur la console posée
devant elle. Il voyage donc avec l'abonnement jusqu'au hub, qui filtre à
l'envoi ; la page applique le même filtre pour ses propres avis.

Rien ne part sans un *changement* — répéter « Track #1 déborde » toutes les dix
secondes ferait couper les notifications au bout de deux minutes, et on ne les
rallume pas. Le premier chargement n'alerte de rien : ouvrir la console sur une
salle déjà coupée est un état, pas un événement. **Deux étiquettes par salle**
— une pour la machine, une pour le déroulé — pour qu'un « c'est parti » ne vienne
jamais effacer un « ne répond plus » resté non lu. Un clic sur l'avis ouvre
l'onglet concerné, maintenant que chaque onglet a son adresse.

Début et fin se lisent sur le **cycle de vie** (`Commencer` / `Terminer`), pas
sur la couleur de la pastille : une conférence terminée à l'heure passe
directement de « en cours » à « aucune », et l'événement serait manqué.

La permission est demandée **au clic**, jamais au chargement : un navigateur qui
voit la question arriver seule la refuse définitivement. Le réglage est retenu
par appareil.

**Console fermée, ça marche aussi.** Activer les notifications abonne le
navigateur en **Web Push** : le hub garde l'abonnement, un service worker
(`/sw.js`) reçoit l'avis et l'affiche même quand plus personne ne regarde. C'est
le cas qui compte le jour J — le téléphone est dans une poche, pas devant les
yeux.

Le corollaire est que **le hub doit constater lui-même ce qui change** : une
veille compare l'état des salles toutes les quinze secondes et pousse les mêmes
avis que la page, avec les mêmes règles — rien au premier tour, rien sans
changement. Elle ne tourne pas tant que personne n'est abonné.

Les deux mécanismes emploient **la même étiquette** par salle : quand la console
est ouverte *et* abonnée, le second avis remplace le premier au lieu d'empiler
deux fois la même information.

Les clés VAPID sont fabriquées au premier démarrage et gardées en base ;
`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` servent à survivre à une base recréée.
Une clé illisible **désactive le push et n'arrête pas le hub** — c'est un
confort de supervision, pas le cœur du système —, mais le dit en erreur au
démarrage.

⚠️ **Trois conditions.** Hors `localhost`, le hub doit être servi en **HTTPS** —
ouvrir la console par l'adresse IP du hub, ce qu'on fait naturellement depuis un
téléphone, ne suffit pas. Sur **iOS**, la console doit avoir été **ajoutée à
l'écran d'accueil**. Et surtout : **s'abonner exige qu'Internet soit joignable
depuis le navigateur**, même pour un hub local — le navigateur doit s'enregistrer
auprès du service de push de son éditeur (Google pour Chrome, Mozilla pour
Firefox). Un réseau d'événement fermé refuse l'abonnement *et* la réception ;
certains navigateurs (Brave, quelques Chromium de distribution) désactivent le
push d'eux-mêmes.

C'est la limite structurelle de ce mécanisme, et elle va contre le reste du
système : tout ici est fait pour tenir sans réseau, le Web Push non. Il faut le
lire comme un confort pour l'organisation — savoir depuis le couloir qu'une
salle déborde — et non comme un canal d'alerte sur lequel s'appuyer le jour J.

Sans push disponible, le bouton reste, avec les notifications de page seules —
un avertissement qui ne traverse pas le verrouillage vaut mieux que pas
d'avertissement — et la console dit laquelle des deux portées elle a obtenue.

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

Ce qui vaut aussi pour la façon dont on *lance* le hub. Un Ctrl-C part vers tout
le groupe de processus au premier plan : le hub le reçoit alors en même temps
que le `node --watch` qui le supervise, et meurt avant la fin de son drainage —
les mêmes fichiers résiduels, par un autre chemin. Et `pnpm`, sur SIGTERM, tue
son enveloppe `sh -c` en laissant le processus node orphelin, base ouverte.
C'est pour ça que `scripts/dev-salles.sh` lance les applications directement,
hors `pnpm run`, chacune dans son propre groupe de processus, et leur adresse
SIGTERM une par une — puis SIGKILL après 8 s, pour la salle qui se bloque dans
sa fermeture après avoir déjà rendu son port.

## Configurer les deux OBS

Deux instances par salle, et le partage est net : **OBS-A projette dans la
salle, OBS-B enregistre et diffuse**. L'application ne crée jamais ni scène ni
source — elle bascule les scènes d'OBS-A, lit et enregistre sur OBS-B.

### OBS-A — ce que voit la salle

Sa sortie part au vidéoprojecteur (clic droit sur l'aperçu → *Projecteur plein
écran (Programme)* → sortie du projecteur). Deux scènes, plus une facultative :

| Rôle | Scène par défaut | Contenu |
|---|---|---|
| `LIVE` | `Direct — capture HDMI` | La capture HDMI du portable du speaker. |
| `HOLD` | `Habillage — écran de salle` | Une **Browser Source** sur `http://127.0.0.1:7788/display/projector`. |
| `RELAY` | *(à créer si besoin)* | Le flux d'une autre salle (NDI ou SRT). L'acheminement est affaire de réseau ; l'application ne fait que basculer dessus. |

La Browser Source de `HOLD` **est** l'écran de salle : sponsors, programme,
compte à rebours, message, mur et son QR. Ce ne sont pas des slides — c'est une
page servie en local, pilotée par les quatre boutons « Écran de salle » de la
régie. La régler à la taille du canevas (1920 × 1080), et **décocher « Rafraîchir
le navigateur quand la scène devient active »** : la page se met à jour toute
seule par SSE, la recharger ferait clignoter la projection à chaque bascule.

OBS-A est la **seule** instance dont l'application change les scènes : boutons
« Projection » de la régie, touches `L` et `H`.

### OBS-B — la captation et le direct

| Rôle | Scène par défaut | Contenu |
|---|---|---|
| `TALK` | `Talk — caméra + slides` | Caméra + slides composées, **plus** une Browser Source transparente sur `http://127.0.0.1:7788/display/overlay`, tout en haut de la pile. |
| `CAM_ONLY` | `Caméra seule` | |
| `SLIDES_ONLY` | `Slides seules` | |

L'habillage transparent porte le titrage du talk — titre, intervenants, pastille
de catégorie — et le logo de l'événement : c'est ce qui fait un **master déjà
habillé**, prêt pour la VOD sans montage.

Il ne porte **que** cela, et c'est une règle : tout ce qui est dans cette page
est incrusté dans l'enregistrement et dans le direct. Un témoin
d'enregistrement y a figuré ; utile à l'opérateur, mais gravé dans la vidéo
livrée. Ce repère-là vit en régie, panneau « Captation », où il ne coûte rien à
personne.

Ces trois rôles sont déclarés et vérifiés à la connexion, mais **l'application
ne bascule jamais les scènes d'OBS-B** — la régie n'a pas de boutons pour elle.
Le changement de cadrage se fait à la main dans OBS.

C'est OBS-B qui **enregistre** (`Paramètres → Sortie → Enregistrement` : un
dossier, et MKV plutôt que MP4, un OBS qui tombe n'abîme pas un MKV) et qui
**diffuse**. Rien à saisir pour la diffusion : le hub pousse l'URL RTMP et la
clé, l'application les applique juste avant de démarrer. Le nom de fichier non
plus : elle écrit le format juste avant la prise, puis renomme le fichier à
l'arrêt en `2026-10-30_track1_1100_titre-du-talk.mkv` et dépose le sidecar
`.json` à côté. **Le dossier reste celui d'OBS** — le champ « Dossier des
enregistrements » du ⚙ est informatif, il ne déplace rien.

C'est aussi OBS-B qui alimente les vumètres de la régie.

### Le bandeau live, où l'on veut

`http://127.0.0.1:7788/display/overlay-live` est une **seconde source
transparente**, indépendante de l'habillage. Elle porte deux choses : la
**question du public** choisie en régie, et ce que la console met à l'antenne —
« on reprend dans 5 minutes », « le son est en cours de réparation ». Quand les
deux existent, le message de la console passe devant : s'il y en a un, c'est
qu'il se passe quelque chose. La question revient dès qu'il est retiré.

**À poser dans les scènes d'OBS-A, et nulle part ailleurs** : la scène `LIVE`
pour que la salle voie le message **par-dessus les slides du speaker**. Même
réglage que l'habillage : taille du canevas, pas de rafraîchissement à
l'activation de la scène.

**Jamais dans OBS-B.** C'est la règle qui garantit tout le reste : ce qui entre
dans OBS-B est gravé dans la VOD, et les consignes d'exploitation de la console
n'y ont pas leur place — « on reprend dans 5 minutes » incrusté dans un talk
livré n'a aucun sens six mois plus tard. La question du public, elle, y va bien,
mais par l'habillage de captation (`/display/overlay`), qui ne porte qu'elle.

C'est là toute la différence avec le mode « Message » de l'écran de salle, qui
**prend** l'écran entier : le bandeau se superpose et n'interrompt rien, le talk
continue dessous. Les deux servent à des moments différents — une évacuation
prend l'écran, un retard de cinq minutes non.

### Question du public : deux canaux, quatre surfaces

La question et le bandeau de la console sont **deux états distincts**, et c'est
délibéré. Tant qu'ils partageaient un seul champ, un message envoyé du hub
s'affichait à la place de la question — et surtout, aucune surface ne pouvait
montrer l'un sans risquer l'autre.

| Surface | Question du public | Message de la console |
|---|---|---|
| `/display/overlay` (OBS-B, VOD) | **oui** | jamais |
| `/display/overlay-live` (OBS-A, salle) | oui | oui, prioritaire |
| `/display/projector` mode « Question choisie » | oui, en grand | non — il a son propre mode « Message » |
| `/regie` | la liste, et celle à l'antenne | zone Signalements |

La question à l'antenne est **rattachée à la conférence pilotée** : elle tombe
d'elle-même au talk suivant. Sans ça, elle resterait incrustée dans l'habillage
de captation pendant que le speaker d'après s'installe — gravée dans sa VOD,
adressée à quelqu'un d'autre.

Côté console, onglet **Messages**, panneau « Bandeau live » : cinq modèles prêts
à envoyer (questions, pause, micro, retard, enregistrement) qui **remplissent le
champ** plutôt que de partir directement — un modèle est un point de départ, pas
un rail —, un bouton pour retirer le bandeau, et la liste de ceux **déjà
passés**, avec celui qui est en cours et un bouton pour le remettre sans le
retaper. L'historique est lu dans les commandes déjà émises : elles sont
persistées et datées, une seconde copie ne pourrait que diverger de ce qui est
réellement parti dans les salles.

### Le mur : commun à l'événement, pas à une salle

**Un message du public s'adresse à Cloud Nord, pas à la pièce où son auteur se
trouve.** Le mur dépose donc sans salle (`roomId: null`, ce qui vaut déjà
« partout » côté hub) et s'affiche sur les trois écrans. Le limiter à une salle
en faisait un canal de plus à surveiller, et privait les deux autres écrans de
ce qui s'y disait.

La page le dit **avant** le formulaire, pas en petit après le bouton : « votre
message s'affiche dans toutes les salles », avec le nombre réel de salles. Et
elle montre **ce qui est déjà à l'écran** — les derniers messages passés en
relecture, relus toutes les quinze secondes. Sans ça, déposer un message
revenait à parler dans le vide : rien ne montrait que d'autres écrivaient, ni
que ça finissait réellement projeté. C'est la différence entre un formulaire de
contact et un mur.

Le choix de salle, lui, a déménagé dans l'onglet **Questions** — le seul endroit
où il compte encore.

### Questions du public, de bout en bout

Le QR de chaque salle porte la sienne, mais un participant arrive aussi par un
lien partagé, ou change de salle entre deux talks — il tombait alors sur
« ouvrez le lien de votre salle » sans savoir lequel ouvrir, et sa question
restait dans sa tête. Le choix est mémorisé sur le téléphone et recopié dans
l'adresse. La page affiche aussi **le talk en cours**, relu chaque minute :
« posez votre question » doit dire à propos de quoi, et la question part
**rattachée à la conférence**.

La console du hub y mène directement : un lien **Mur public** dans l'en-tête, et
une colonne *Mur* dans le tableau des salles — c'est la page que les
participants scannent, et la seule façon de voir ce qu'ils voient.

En régie, la modale de consultation gagne un onglet **Questions** : la liste
triée par votes, un bouton pour relire, et **Afficher** sur chaque question, qui
la met sur le bandeau live. Le speaker répond, la salle lit — le talk continue
dessous. « Retirer le bandeau » l'enlève.

La liste est relue **à la demande** — à l'ouverture de l'onglet et par le bouton
— et non poussée en continu : la régie ne la regarde qu'en fin de talk.

### « Notez le talk » — le QR OpenFeedback

Un mode d'écran de plus, dans les boutons « Écran de salle » de la régie :
le QR de la conférence **en cours** sur OpenFeedback, à afficher en fin de talk
pendant que le public est encore assis. C'est le seul moment où l'on obtient des
retours, et un lien dicté à voix haute n'est jamais scanné.

**Aucun appel réseau, aucune clé d'API.** OpenFeedback réutilise les
identifiants de session de l'export « conference-center » — vérifié sur
l'édition 2026, les 27 concordent — et sa route publique est
`/{projet}/{aaaa-mm-jj}/{session}`. L'adresse se déduit donc du programme déjà
en cache, et le QR se dessine réseau coupé : exactement le moment où l'on ne
veut pas d'une image manquante devant deux cents personnes. La clé d'API ne sert
qu'à *lire* les votes, ce que cette fonctionnalité ne fait pas — il n'y a donc
aucun secret à déployer.

Le projet (`cloud-nord-2026`) est un champ de la configuration de salle,
modifiable dans le **⚙** de la régie : il change une fois par édition. Hors
conférence, l'écran l'annonce plutôt que de montrer un QR mort.

### Deux présentations pour la question

`/display/overlay-live` sert **deux mises en page**, choisies dans l'adresse de
la source OBS :

| Adresse | Ce que ça donne |
|---|---|
| `/display/overlay-live` | Un **bandeau** en haut, sobre — pour un plan de caméra |
| `/display/overlay-live?style=encart` | Un **encart** en bas à droite, avec son libellé « Question du public » — fait pour passer par-dessus des slides sans manger leur contenu |

Un paramètre d'adresse plutôt qu'un réglage : c'est une décision de scène, prise
une fois en montant la source, pas un geste de régie en pleine conférence. Les
deux sont dans le menu **Écrans** de la régie.

**Le passage d'une question à l'autre est animé, en deux temps** : l'ancienne
sort, la nouvelle est posée, puis elle entre. Remplacer le texte en place
donnerait un saut — deux questions de longueurs différentes se substituent d'un
coup, et le spectateur ne sait pas si elle a changé ou si elle a toujours été
là. Le bandeau descend, l'encart monte : chacun vient du bord dont il est
proche. L'animation ne se rejoue **que** sur un vrai changement, jamais sur un
état reçu identique.

### La question du public, en grand

« Afficher » dans l'onglet Questions pose la question sur le **bandeau vidéo**.
Pour la mettre devant **toute la salle**, quel que soit ce qu'OBS diffuse au
même moment, le bouton **Question choisie** des modes d'écran la projette en
grand, avec la même arrivée en fondu. Une seule sélection, trois surfaces :
bandeau, encart, ou pleine page sur le vidéoprojecteur — elles ne servent pas au
même moment.

### Le serveur WebSocket, sur chacune

*Outils → Paramètres du serveur WebSocket* → activer. Port **4455** pour OBS-A,
**4456** pour OBS-B (ce sont les valeurs par défaut de l'application), mot de
passe si vous en mettez un. Deux instances sur la même machine : lancer la
seconde avec `--multi` et un profil distinct, sinon elles se disputent le port.

Puis, dans la régie, bouton **⚙** : les deux adresses, les mots de passe, et
pour chaque rôle la scène **choisie dans la liste** — elle est lue sur OBS, et
c'est la faute de frappe qui produit un rôle introuvable. Enfin **Connecter**
sur chaque ligne. Le panneau Diagnostic doit finir vert des deux côtés, sans
rôle absent.

### Ce que « Commencer » entraîne

Deux gestes que la régie faisait de mémoire, et qu'elle oubliait aux moments les
plus coûteux. Les deux sont dans le **⚙**, panneau « Au démarrage d'une
conférence », **actifs par défaut** :

- **Avertir si l'enregistrement n'est pas lancé.** Appuyer sur Commencer alors
  qu'OBS-B n'enregistre pas ouvre une modale : *Enregistrer et commencer* /
  *Commencer sans enregistrer* / *Annuler*. La question ne vaut qu'avant — une
  fois la conférence lancée, l'enregistrement démarré manquera toujours les
  premières minutes, et une VOD absente ne se rattrape pas le soir. Si
  l'enregistrement refuse de partir, la conférence ne démarre pas non plus :
  commencer quand même rendrait l'avertissement mensonger la fois suivante.
  « Annuler » existe parce que la question peut tomber au mauvais moment — on
  visait Terminer, ou l'intervenant n'est pas prêt — et qu'un avertissement sans
  porte de sortie se clique sans être lu.
- **Passer à l'antenne**, scène `LIVE` par défaut, réglable ou désactivable.
  Sans elle, l'habillage restait à l'écran pendant les premières phrases de
  l'intervenant. La bascule suit le démarrage, jamais l'inverse : une scène
  prise sans conférence lancée mettrait la salle à l'antenne sur rien.

Une salle qui n'enregistre pas du tout décoche l'avertissement, sinon il devient
un clic de plus à chaque conférence.

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

### Ce que dit la pastille

Elle portait la seule connectivité : une salle en dépassement de dix minutes
s'affichait en vert, parce que sa machine répondait. Deux informations, deux
traits — le **remplissage** dit où en est la conférence, le **contour** dit ce
qu'on sait de la salle.

| Remplissage | Mot | État |
|---|---|---|
| gris | hors créneau | rien au programme, ou entre deux créneaux |
| bleu | pause | la salle est occupée, mais rien ne s'y joue |
| gris | pas commencée | le créneau tourne, personne n'a appuyé sur **Commencer** |
| ambre | retard au démarrage | toujours rien lancé cinq minutes après le début du créneau |
| vert | en cours | talk lancé, plus de cinq minutes devant lui |
| ambre | vers la fin | cinq minutes ou moins — le moment où l'on ne lance pas un talk à côté |
| gris | terminée en avance | **Terminer** avant l'heure : la salle est libre, et la voisine peut en tenir compte |
| rouge | dépassement | le créneau est clos, la conférence est toujours marquée en cours |

La couleur **croise le programme et le cycle de vie** (`Commencer` / `Terminer`).
Le programme donne le créneau, le cycle de vie donne ce qui s'y joue vraiment :
sans lui, un créneau que personne n'a lancé se lisait « en cours », et une salle
qui déborde n'existait pas — passé l'heure de fin, le programme passe simplement
au créneau suivant.

⚠️ Le corollaire est assumé : **une salle qui n'utilise pas les boutons reste
« pas commencée » puis « en retard » toute la journée.** La console ne peut pas
deviner qu'un talk tourne si personne ne le dit, et c'est le mot affiché à côté
de la pastille qui empêche de lire cette absence comme une panne.

Le contour reste gris pour ne jamais concurrencer ces couleurs : rien en
`ONLINE`, un anneau en `DEGRADED`, et une **pastille creuse** quand la salle est
muette — on ne sait plus ce qui s'y joue, et le peindre serait pire que de se
taire. Partout, un mot accompagne la couleur : elle se regarde de loin, et tout
le monde ne distingue pas les teintes.

Le calcul vit chez le hub (`roomConferenceState`) : l'heure qui fait foi est la
sienne — elle peut être simulée — et lui seul tient le cycle de vie de toutes
les salles. La régie **reprend du hub les quatre états qu'il est seul à
connaître** (pas commencée, retard, terminée, dépassement) et **recalcule le
reste sur son cache**, chaque seconde : reprendre aussi « vers la fin » d'une
vue rafraîchie toutes les quelques secondes ferait manquer le basculement, qui
est justement ce qu'on surveille. Passé une minute sans nouvelles, la vue du hub
décrit un passé et le programme local reprend la main — pendant une coupure, la
salle d'à côté finit quand même à l'heure prévue.

Les **signalements** — fin de talk à côté, message parti à la console, hub
rejoint — s'affichent en bandeau sous le flux et **s'effacent seuls au bout de
30 secondes** : un bandeau qui ne part pas cesse d'être lu, et la régie
finissait la journée avec cinq signalements périmés au-dessus des commandes. La
règle est appliquée deux fois, et c'est voulu : le runtime les retire sur son
tic d'horloge (5 s), pour que rien ne ressuscite au rechargement, et la page
cesse de les afficher à la seconde exacte. La croix reste là pour écarter plus
tôt.

Ce qui se consulte — programme complet de la salle, programme d'une autre
salle, état des salles vu du hub — passe en **modale**, à un clic ou aux
touches `P` et `S`, `Échap` pour refermer. Les deux programmes **surlignent le
créneau en cours** et s'ouvrent dessus. Pour sa propre salle, c'est l'état
réellement piloté : un talk lancé en retard reste le talk en cours. Pour la
salle d'à côté, dont on ne reçoit pas l'état, c'est le programme lu à l'heure du
hub — **heure simulée comprise**, ce qui permet de dérouler la journée du 30
octobre des mois à l'avance. Sans ce repère, la modale déroulait une liste
d'horaires et laissait faire le calcul de tête, en pleine régie. Les commandes et les raccourcis
restent actifs modale ouverte : une conférence ne s'arrête pas parce qu'on
consulte le programme.

Sur un écran court (moins de 700 px de haut), une règle de densité resserre
panneaux et boutons plutôt que de laisser sortir une commande. Au-dessous de
1024 px de large, la grille retombe sur une colonne défilante — faute de mieux.

### Configurer la salle depuis la régie (⚙)

Le bouton **⚙** de l'en-tête ouvre les réglages de la salle : adresses et mots
de passe des deux OBS, mapping rôle → scène, port de l'écran local, dossier des
enregistrements, préfixe de fichiers, salle relayée. C'est là que se branchent
des instances OBS réelles — ces valeurs se constatent devant les machines, pas
depuis une console à l'autre bout du bâtiment.

Trois propriétés qui expliquent la forme :

- **Le hub reste la source de vérité.** L'enregistrement part chez lui
  (`rooms.configure`) et la salle se resynchronise. Garder le réglage en local
  irait plus vite mais mentirait : le prochain `sync` repousse la configuration
  du hub et la saisie disparaîtrait sans un mot. Hors ligne, « Enregistrer » est
  donc désactivé et le dit.
- **Chaque instance se connecte séparément.** Enregistrer ne reconnecte rien :
  les contrôleurs portent leurs paramètres à la construction, donc appliquer
  voudrait dire couper — y compris une captation en cours. Chaque instance a
  son bouton **Connecter / Reconnecter**, qui enregistre d'abord ce qui est à
  l'écran (sinon on ouvrirait la connexion sur les valeurs d'avant la saisie),
  puis rouvre cette instance-là. Tant qu'un réglage enregistré n'est pas
  appliqué, la ligne d'état affiche « réglages non appliqués ». Le bouton est
  bloqué sur une instance qui **enregistre**, et le reste sur une instance
  tombée en enregistrant : son dernier état connu est justement périmé.
  À la main, une seule tentative — l'échec revient tel quel à l'opérateur — mais
  la boucle de reprise repart en fond, pour que l'instance finisse par se
  rattacher seule.
- **Bornée à la salle appelante.** La cible est le jeton, pas l'entrée : il
  n'existe aucune forme de l'appel qui configure une autre salle. L'identité
  (`id`, `name`, `trackId`) vient du programme et la clé de diffusion descend du
  hub — ni l'une ni l'autre n'est dans le correctif accepté.
- **Les noms de scènes se choisissent, ils ne se retapent pas.** Les listes sont
  lues sur OBS (`GetSceneList`), puisque c'est la faute de frappe qui produit un
  rôle introuvable. Une scène configurée mais absente d'OBS reste proposée,
  signalée comme telle : la faire disparaître changerait la configuration à
  l'insu de l'opérateur. « Relire les scènes d'OBS » rafraîchit la liste après
  un renommage, sans rien reconnecter.

Le mot de passe OBS ne redescend jamais jusqu'à la page : elle sait seulement
qu'il y en a un. Un champ laissé vide vaut « inchangé » — corriger un port
n'efface pas le mot de passe au passage — et une case explicite sert à le
retirer.

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
