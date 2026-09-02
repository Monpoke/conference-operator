# syntax=docker/dockerfile:1

# Image du hub.
#
# Trois choses gouvernent ce fichier, et expliquent qu'il ne ressemble pas à un
# Dockerfile Node habituel :
#
#  1. **Le hub n'a pas d'étape de build.** Il démarre en TypeScript via `tsx`
#     (`pnpm start`) : ce sont ses sources qui partent dans l'image, pas un
#     `dist/`. Deux choses sont compilées ici — la console et la régie, deux
#     applications Vue, donc deux bundles. Elles partagent une étape, jetée après
#     coup ; le hub reçoit deux dossiers d'assets qu'il sert, et n'importe rien
#     d'elles. La régie y figure parce que le hub la sert aussi, pour la régie
#     mobile : le même bundle que celui qu'embarque l'installeur d'une salle.
#  2. **La disposition du monorepo doit être préservée.** `apps/hub-server/src/db.ts`
#     résout ses migrations en `../../../packages/db/migrations/hub`, relativement
#     à sa propre position. Aplatir l'arborescence — ce que ferait un
#     `pnpm deploy` — casserait la migration au premier démarrage, dans un
#     conteneur, le jour où personne n'a envie de chercher ça.
#  3. **Rien de ce qui sert à développer n'entre dans l'image finale.** C'est ce
#     qui sépare 620 Mo de 330 : la chaîne d'outils pèse à elle seule plus que
#     tout le reste. D'où l'étape de construction séparée, l'installation
#     `--prod`, et l'élagage qui la suit — `--prod` ne suffit pas, voir plus bas.
#
# L'installation est en outre **filtrée sur le hub**
# (`--filter @cloudnord/hub-server...`) : sans ce filtre, `pnpm` installerait
# aussi le client de salle et téléchargerait Electron — cent cinquante
# mégaoctets pour un binaire qui ne tournera jamais ici.

# Socle interchangeable : `--build-arg NODE_VERSION=22-alpine` retire encore
# 66 Mo. La glibc reste le défaut — un hub d'événement fait des appels sortants
# (import du programme, S3, Web Push), et le binaire musl de `better-sqlite3`
# n'est pas celui contre lequel l'équipe développe. Le choix est ouvert, pas
# subi.
ARG NODE_VERSION=22-bookworm-slim

# --- Console --------------------------------------------------------------
# La seule étape de ce fichier qui compile quelque chose, et elle ne survit pas.
#
# La console et la régie sont des applications Vue : elles ont un bundle, contrairement au hub
# qui démarre en TypeScript via `tsx`. Le construire ici plutôt que de committer
# sa sortie garde le dépôt lisible — un bundle minifié réécrit à chaque retouche
# d'interface transforme chaque relecture en diff illisible — et garde l'image
# finale exempte de Vue, de Vite et de leur outillage : rien de cette étape n'y
# entre, sinon le dossier `dist`.
FROM node:${NODE_VERSION} AS spa
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/hub-admin/package.json apps/hub-admin/
COPY apps/hub-server/package.json apps/hub-server/
COPY apps/regie-web/package.json apps/regie-web/
COPY apps/room-client/package.json apps/room-client/
COPY packages/contract/package.json packages/contract/
COPY packages/db/package.json packages/db/
COPY packages/etat-salle/package.json packages/etat-salle/
COPY packages/format/package.json packages/format/
COPY packages/components/package.json packages/components/
COPY packages/hub-client/package.json packages/hub-client/
COPY packages/program/package.json packages/program/
COPY packages/ui/package.json packages/ui/

# Pas de `--prod` ici : il faut justement l'outillage de construction. Le filtre
# limite l'installation aux graphes des deux applications.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts \
      --filter @cloudnord/hub-admin... --filter @cloudnord/regie-web...

COPY packages/ packages/
COPY apps/hub-admin/ apps/hub-admin/
COPY apps/regie-web/ apps/regie-web/
RUN pnpm --filter @cloudnord/hub-admin build
# La régie, servie par le hub pour la régie mobile — le même bundle que celui
# qu'embarque l'installeur d'une machine de salle. Sans lui, `/regie` répond 503
# en le disant, ce qui est un déploiement incomplet et non un état
# d'exploitation.
RUN pnpm --filter @cloudnord/regie-web build


# --- Construction ---------------------------------------------------------
# Tout ce qui suit est jeté : seul `/repo` sera repris dans l'image finale.
FROM node:${NODE_VERSION} AS builder

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
WORKDIR /repo

# Manifestes d'abord : c'est ce qui rend la couche d'installation réutilisable
# entre deux builds où seul le code a changé.
#
# **Tous** les manifestes de l'espace de travail, pas seulement ceux du hub :
# `--frozen-lockfile` compare le fichier de verrou à l'ensemble des projets
# trouvés. Un manifeste manquant se lit comme un verrou périmé, et l'installation
# échoue sur un message qui ne dit pas ça.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/hub-admin/package.json apps/hub-admin/
COPY apps/hub-server/package.json apps/hub-server/
COPY apps/regie-web/package.json apps/regie-web/
COPY apps/room-client/package.json apps/room-client/
COPY packages/contract/package.json packages/contract/
COPY packages/db/package.json packages/db/
COPY packages/etat-salle/package.json packages/etat-salle/
COPY packages/format/package.json packages/format/
COPY packages/components/package.json packages/components/
COPY packages/hub-client/package.json packages/hub-client/
COPY packages/program/package.json packages/program/
COPY packages/ui/package.json packages/ui/

# `--prod` : ni typescript, ni turbo, ni les tests. `tsx` y survit parce qu'il
# est déclaré en dépendance de production du hub — ce qu'il est réellement,
# puisque c'est lui qui exécute le serveur.
#
# `--ignore-scripts` : le seul paquet à script du graphe est `better-sqlite3`,
# et il n'a rien à compiler — c'est un module **Node-API** livré avec un binaire
# par plateforme. Le script ne faisait que passer par node-gyp pour le
# constater, au prix d'une chaîne de compilation complète dans l'image de
# construction. S'en passer rend aussi le socle interchangeable : voir
# `NODE_VERSION` ci-dessus.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --filter @cloudnord/hub-server...

# Les sources ensuite. `tsx` les lit telles quelles au démarrage ; la feuille
# Tailwind de `@cloudnord/ui` est versionnée (`src/generated/`), il n'y a donc
# rien à compiler ici non plus.
COPY packages/ packages/
COPY apps/hub-server/ apps/hub-server/

# Les deux bundles, construits à l'étape précédente. Le hub les sert, il ne les
# importe pas : c'est ce qui permet à `pnpm typecheck` et `pnpm test` de ne
# jamais déclencher de build Vite, et à la CI de tenir sous la minute.
COPY --from=spa /repo/apps/hub-admin/dist apps/hub-admin/dist
COPY --from=spa /repo/apps/regie-web/dist apps/regie-web/dist

# Ce que `--prod` ne suffit pas à écarter : une centaine de mégaoctets
# d'outillage de test et de build, que `better-auth` impose en peer dependencies
# NON optionnelles (`vitest`, `drizzle-kit`, et derrière eux rolldown,
# lightningcss, happy-dom, deux copies d'esbuild). Le script recalcule ce que le
# hub peut réellement atteindre depuis ses sources — d'où leur copie juste
# au-dessus — et supprime le reste ; son en-tête explique la méthode et ses
# limites.
COPY scripts/elaguer-modules-conteneur.mjs scripts/
RUN node scripts/elaguer-modules-conteneur.mjs

# `better-sqlite3` livre dans son paquet npm un binaire par plateforme — huit,
# dont sept ne serviront jamais ici (macOS, arm, musl). Une quinzaine de
# mégaoctets qu'on ne transporte pas. On garde les deux variantes Linux x64 :
# la glibc pour l'image telle qu'elle est, la musl pour qu'un passage à Alpine
# ne se solde pas par un module introuvable au démarrage.
RUN find node_modules/.pnpm -path '*/better-sqlite3/prebuilds/*.node' \
      ! -name 'linux-x64.node' ! -name 'linuxmusl-x64.node' -delete


# --- Image finale ---------------------------------------------------------
# Ni pnpm, ni corepack, ni compilateur : le hub se lance avec `node`, et rien
# d'autre n'a de raison d'être là.
FROM node:${NODE_VERSION} AS runtime

# Le hub écrit sa base SQLite et rien d'autre. Le chemin par défaut sort de
# l'arborescence du code : un volume monté sur `/data` survit au remplacement de
# l'image, ce qu'un `./data` relatif au dépôt ne garantirait pas.
ENV NODE_ENV=production \
    MODE=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_PATH=/data/hub.db

COPY --from=builder --chown=node:node /repo /repo
RUN mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 8787

# `/health` ne touche ni la base ni le programme : il répond tant que Fastify
# écoute, ce qui est exactement la question posée ici.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /repo/apps/hub-server

# `pnpm start` s'interposerait entre le signal et le hub : sur SIGTERM, pnpm tue
# son enveloppe `sh -c` et laisse le processus node orphelin, base ouverte —
# le README le décrit pour le développement, c'est pire dans un conteneur.
# `node` en PID 1 reçoit donc SIGTERM directement, et l'arrêt gracieux du hub
# (drainage, WebSockets, fermeture de la base) se déroule comme prévu.
CMD ["node", "--import", "tsx", "src/main.ts"]
