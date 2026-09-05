# Conference Operator — régie de salle & hub

Régie multi-salles pour une conférence : un **hub** qui porte le programme, les
salles et la supervision, et une **régie de salle** par machine — écran de
projection, pilotage d'OBS, remontée des enregistrements. Une salle continue de
fonctionner réseau coupé ; le hub la rattrape quand il revient.

Pour le reste — décisions, appairage, OBS, empaquetage, publication —
[CONCEPTION.md](CONCEPTION.md). Pour tenir une salle le jour J,
[le RUNBOOK](apps/room-client/RUNBOOK.md).

## Prérequis

Node 24 ou plus, et pnpm par corepack (la version exacte est figée par
`packageManager`).

```bash
corepack enable && pnpm install
```

## Lancer le hub

```bash
cd apps/hub-server
cp .env.example .env
openssl rand -base64 48        # à coller dans BETTER_AUTH_SECRET
```

Créer un compte opérateur — l'inscription publique est fermée, sans ce compte la
console est inaccessible et personne ne peut appairer une machine :

```bash
pnpm --filter @conference-operator/hub-server operator vous@exemple.fr "Régie" <mot-de-passe>
```

Puis :

```bash
MODE=dev pnpm --filter @conference-operator/hub-server dev
```

Au premier démarrage, le hub importe le programme depuis `PROGRAM_SOURCE_URL` et
crée les salles à partir de `event.tracks[]`.

| | |
|---|---|
| Console | <http://localhost:8787/admin> |
| Mur public | <http://localhost:8787/mur?salle=…> |
| Régie mobile | <http://localhost:8787/regie> |

## Lancer une régie

**Sans Electron ni OBS** — le mode recommandé pour développer, notamment sous
WSL, en conteneur ou sur une machine distante. Toute la logique du client vit
hors d'Electron, c'est ce qui le rend possible ; les pages s'ouvrent dans un
navigateur sur le port affiché (`/regie`, `/display/projector`).

```bash
HUB_ORIGIN=http://localhost:8787 pnpm --filter @conference-operator/room-client dev:headless
```

**Avec Electron** — pour les fenêtres, le menu « Écrans », le sélecteur de
dossier VOD :

```bash
MODE=dev HUB_ORIGIN=http://localhost:8787 pnpm --filter @conference-operator/room-client dev
```

Sans `HUB_ORIGIN`, l'application demande l'adresse dans une fenêtre au
démarrage, et la retient.

**Un hub et une ou deux salles d'un seul terminal** — deux salles sont
nécessaires dès qu'on touche à ce qui est partagé entre elles (mur des
questions, message poussé, modération) :

```bash
pnpm dev:duo               # hub + une salle headless
pnpm dev:trio              # hub + deux salles headless
pnpm dev:duo --electron    # la première salle sous Electron
```

Dans tous les cas la salle affiche un **code d'appairage** : le saisir dans la
console (« Machines en attente »), choisir une salle, approuver.

## Variables d'environnement — hub

`MODE=production` est le défaut : les commodités de développement y sont
**ignorées même si elles sont renseignées**, et le hub le dit au démarrage et
dans la console.

**L'essentiel**

| Variable | Rôle | Défaut |
|---|---|---|
| `MODE` | `production` ou `dev` — l'unique interrupteur devant les commodités de développement | `production` |
| `BETTER_AUTH_SECRET` | Secret de signature des sessions | **obligatoire** |
| `PUBLIC_URL` | Base publique du hub : Better Auth et l'URI de vérification d'appairage | `http://localhost:8787` |
| `PORT` / `HOST` | Écoute | `8787` / `0.0.0.0` |
| `DATABASE_PATH` | Fichier SQLite du hub | `./data/hub.db` |
| `LOG_LEVEL` | Niveau de journal | `info` |
| `PROGRAM_SOURCE_URL` | Export « conference-center ». **Amorce le premier démarrage seulement** — ensuite le réglage de la console fait foi. C'est aussi ce qui **nomme l'événement** partout | — |

**Appairage des machines**

| Variable | Rôle | Défaut |
|---|---|---|
| `DEVICE_POLL_INTERVAL` | Cadence de polling imposée aux machines (RFC 8628) | `5s` |
| `DEVICE_CODE_TTL` | Durée de vie d'un code d'appairage. **La rallonger le jour J** : deux minutes, c'est le temps de traverser une salle | `2m` |

**Connexion Google Workspace** — facultative. Renseigner `GOOGLE_CLIENT_ID` sans
les deux autres **empêche le hub de démarrer**, plutôt que de monter une console
dont le bouton échoue à chaque clic.

| Variable | Rôle |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Client OAuth « Application Web », redirection `<PUBLIC_URL>/api/auth/callback/google` |
| `GOOGLE_HOSTED_DOMAIN` | Domaine autorisé. **Tout compte du domaine est opérateur** : c'est l'annuaire qui fait la liste |

**Notifications poussées** (Web Push) — facultatives. Sans elles le hub fabrique
une paire au premier démarrage et la garde en base ; les renseigner sert à
survivre à une base recréée.

| Variable | Rôle | Défaut |
|---|---|---|
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Paire de clés (`npx web-push generate-vapid-keys`) | fabriquée au démarrage |
| `VAPID_SUBJECT` | Contact annoncé aux services de push | dérivé de `PUBLIC_URL` |

**Rapatriement des rushes** — facultatif. Les trois premières vont ensemble :
**à moitié renseignées, le hub refuse de démarrer**.

| Variable | Rôle | Défaut |
|---|---|---|
| `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Stockage compatible S3. Les salles ne reçoivent jamais ces clés : le hub signe des adresses à durée de vie courte | — |
| `S3_BUCKET` | Bucket. **Amorce seulement** — ensuite l'onglet VOD de la console fait foi | — |
| `S3_REGION` | Entre dans la signature, même quand le fournisseur l'ignore | `us-east-1` |
| `S3_FORCE_PATH_STYLE` | Adressage `endpoint/bucket/clé`, le seul qui marche sur une IP | `true` |
| `S3_CA_CERT` | PEM d'une CA interne. Node n'utilise pas le magasin du système. Descendu aux salles au sync : rien à poser sur les machines | — |
| `VOD_ABANDON_MINUTES` | Abandon d'un téléversement muet, et fermeture de son multipart | `30` |

**Mur social** — facultatif ; sans hashtag, rien n'est interrogé.

| Variable | Rôle | Défaut |
|---|---|---|
| `SOCIAL_HASHTAG` | Hashtag suivi | — |
| `MASTODON_INSTANCE` | Instance interrogée | — |
| `X_BEARER_TOKEN` | Jeton d'API X | — |
| `SOCIAL_POLL_INTERVAL_MS` | Cadence d'interrogation | `30000` |

**Développement** — `MODE=dev` seulement.

| Variable | Rôle | Défaut |
|---|---|---|
| `SIMULATED_TIME` | Place **tout le système** à un instant de l'événement ; les salles s'alignent sur l'heure du hub, rien à régler de leur côté | — |
| `VITE_ORIGIN` / `REGIE_VITE_ORIGIN` | Serveurs Vite de la console et de la régie | `…:5173` / `…:5174` |

`CLOCK_CONTROL` n'existe plus : le réglage de l'heure depuis la console suit
`MODE`. La laisser dans un `.env` ne fait rien, et le hub le dit.

## Variables d'environnement — régie de salle

| Variable | Rôle | Défaut |
|---|---|---|
| `HUB_ORIGIN` | Adresse du hub. Absente, elle est demandée dans une fenêtre au démarrage, puis retenue | — |
| `ROOM_ID` | Salle servie par ce poste | — |
| `DATA_DIR` | Dossier de données en mode headless. Sous Electron, c'est le dossier applicatif du système | `./.local-data` |
| `DISPLAY_PORT` | Port du serveur local — à changer si quelque chose l'occupe déjà | `7788` |
| `REGIE_VITE_ORIGIN` | Sert la régie depuis Vite au lieu du bundle compilé | — |
| `MODE` | `dev` simule OBS (scènes, enregistrement, diffusion) et écrit un vrai fichier à l'arrêt | `production` |
| `HEURE_SIMULEE` | Heure locale, pour développer **sans hub**. Dès qu'un hub répond, son heure remplace la valeur | — |
| `OBS_REEL` | En `MODE=dev`, parle à de vraies instances OBS plutôt qu'au simulateur | — |

`OBS_MOCK` n'existe plus : la simulation d'OBS suit `MODE`. Comme
`CLOCK_CONTROL`, la laisser traîner ne fait rien, et la salle le dit.

## Vérifier

```bash
pnpm test          # 1483 tests
pnpm typecheck
pnpm build
```

## Aller plus loin

| | |
|---|---|
| [CONCEPTION.md](CONCEPTION.md) | Décisions, appairage, OBS, écrans, empaquetage, publication |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Conventions de code, langue, tests, messages de commit |
| [RUNBOOK](apps/room-client/RUNBOOK.md) | Procédures de salle, à l'usage de qui tient la régie |
| [packages/db/MIGRATIONS.md](packages/db/MIGRATIONS.md) | Migrations scellées |
