# syntax=docker/dockerfile:1

# Image du hub.
#
# Deux choses gouvernent ce fichier, et expliquent qu'il ne ressemble pas à un
# Dockerfile Node habituel :
#
#  1. **Le hub n'a pas d'étape de build.** Il démarre en TypeScript via `tsx`
#     (`pnpm start`). Il n'y a donc rien à compiler, et rien à copier d'un
#     `dist/` — ce sont les sources qui partent dans l'image.
#  2. **La disposition du monorepo doit être préservée.** `apps/hub-server/src/db.ts`
#     résout ses migrations en `../../../packages/db/migrations/hub`, relativement
#     à sa propre position. Aplatir l'arborescence — ce que ferait un
#     `pnpm deploy` — casserait la migration au premier démarrage, dans un
#     conteneur, le jour où personne n'a envie de chercher ça.
#
# L'installation est **filtrée sur le hub** (`--filter @cloudnord/hub-server...`) :
# sans ce filtre, `pnpm` installerait aussi le client de salle et téléchargerait
# Electron — cent mégaoctets pour un binaire qui ne tournera jamais ici.

ARG NODE_VERSION=22-bookworm-slim

# --- Socle commun ---------------------------------------------------------
FROM node:${NODE_VERSION} AS base
# `ELECTRON_SKIP_BINARY_DOWNLOAD` : ceinture et bretelles. Le filtre d'installation
# suffit, mais un manifeste ajouté un jour au graphe du hub ne doit pas ramener
# 100 Mo de binaire par surprise.
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
WORKDIR /repo

# --- Dépendances ----------------------------------------------------------
FROM base AS deps

# `better-sqlite3` figure dans `onlyBuiltDependencies` : pnpm exécute son script
# d'installation. Le prebuild couvre le cas courant, mais une plateforme sans
# binaire publié bascule sur node-gyp — d'où la chaîne de compilation, qui reste
# dans cette étape et ne suit pas dans l'image finale.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Manifestes d'abord : c'est ce qui rend la couche d'installation réutilisable
# entre deux builds où seul le code a changé.
#
# **Tous** les manifestes de l'espace de travail, pas seulement ceux du hub :
# `--frozen-lockfile` compare le fichier de verrou à l'ensemble des projets
# trouvés. Un manifeste manquant se lit comme un verrou périmé, et l'installation
# échoue sur un message qui ne dit pas ça.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/hub-server/package.json apps/hub-server/
COPY apps/room-client/package.json apps/room-client/
COPY packages/contract/package.json packages/contract/
COPY packages/db/package.json packages/db/
COPY packages/etat-salle/package.json packages/etat-salle/
COPY packages/program/package.json packages/program/
COPY packages/ui/package.json packages/ui/
COPY spikes/orpc-v2/package.json spikes/orpc-v2/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @cloudnord/hub-server...

# Les sources ensuite. `tsx` les lit telles quelles au démarrage ; la feuille
# Tailwind de `@cloudnord/ui` est versionnée (`src/generated/`), il n'y a donc
# rien à compiler ici non plus.
COPY packages/ packages/
COPY apps/hub-server/ apps/hub-server/

# --- Image finale ---------------------------------------------------------
FROM base AS runtime

# Le hub écrit sa base SQLite et rien d'autre. Le chemin par défaut sort de
# l'arborescence du code : un volume monté sur `/data` survit au remplacement de
# l'image, ce qu'un `./data` relatif au dépôt ne garantirait pas.
ENV NODE_ENV=production \
    MODE=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_PATH=/data/hub.db

COPY --from=deps --chown=node:node /repo /repo
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
# le RUNBOOK le décrit pour le développement, c'est pire dans un conteneur.
# `tsx` en PID 1 reçoit donc SIGTERM directement, et l'arrêt gracieux du hub
# (drainage, WebSockets, fermeture de la base) se déroule comme prévu.
CMD ["node", "--import", "tsx", "src/main.ts"]
