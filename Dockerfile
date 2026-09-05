# syntax=docker/dockerfile:1

# The hub's image.
#
# Three things govern this file, and explain why it does not look like a usual
# Node Dockerfile:
#
#  1. **The hub has no build step.** It starts in TypeScript through `tsx`
#     (`pnpm start`): it is its sources that go into the image, not a `dist/`. Two
#     things are compiled here — the console and the control app, two Vue
#     applications, hence two bundles. They share one stage, thrown away
#     afterwards; the hub receives two asset folders which it serves, and imports
#     nothing from them. The control app is there because the hub serves it too,
#     for the mobile control app: the same bundle a room's installer embeds.
#  2. **The monorepo's layout has to be preserved.** `apps/hub-server/src/db.ts`
#     resolves its migrations to `../../../packages/db/migrations/hub`, relative to
#     its own position. Flattening the tree — which a `pnpm deploy` would do —
#     would break the migration on first start-up, inside a container, on the day
#     nobody feels like hunting for that.
#  3. **Nothing used for development enters the final image.** That is what
#     separates 620 MB from 330: the toolchain on its own weighs more than all the
#     rest. Hence the separate build stage, the `--prod` install, and the pruning
#     that follows it — `--prod` is not enough, see below.
#
# The install is moreover **filtered on the hub**
# (`--filter @conference-operator/hub-server...`): without that filter, `pnpm` would also
# install the room client and download Electron — a hundred and fifty megabytes
# for a binary that will never run here.

# An interchangeable base: `--build-arg NODE_VERSION=22-alpine` removes another
# 66 MB. glibc stays the default — an event hub makes outbound calls (programme
# import, S3, Web Push), and `better-sqlite3`'s musl binary is not the one the
# team develops against. The choice is open, not imposed.
ARG NODE_VERSION=22-bookworm-slim

# --- Console --------------------------------------------------------------
# The only stage in this file that compiles anything, and it does not survive.
#
# The console and the control app are Vue applications: they have a bundle, unlike
# the hub which starts in TypeScript through `tsx`. Building it here rather than
# committing its output keeps the repository readable — a minified bundle
# rewritten on every interface tweak turns every review into an unreadable diff —
# and keeps the final image free of Vue, Vite and their tooling: nothing from this
# stage enters it except the `dist` folder.
FROM node:${NODE_VERSION} AS spa
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/hub-admin/package.json apps/hub-admin/
COPY apps/hub-server/package.json apps/hub-server/
COPY apps/control-web/package.json apps/control-web/
COPY apps/room-client/package.json apps/room-client/
COPY packages/contract/package.json packages/contract/
COPY packages/db/package.json packages/db/
COPY packages/room-state/package.json packages/room-state/
COPY packages/format/package.json packages/format/
COPY packages/components/package.json packages/components/
COPY packages/hub-client/package.json packages/hub-client/
COPY packages/program/package.json packages/program/
COPY packages/ui/package.json packages/ui/

# No `--prod` here: the build tooling is precisely what is needed. The filter
# limits the install to the two applications' graphs.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts \
      --filter @conference-operator/hub-admin... --filter @conference-operator/control-web...

COPY packages/ packages/
COPY apps/hub-admin/ apps/hub-admin/
COPY apps/control-web/ apps/control-web/
RUN pnpm --filter @conference-operator/hub-admin build
# The control app, served by the hub for the mobile control app — the same bundle
# a room machine's installer embeds. Without it, `/regie` answers 503 saying so,
# which is an incomplete deployment and not an operating state.
RUN pnpm --filter @conference-operator/control-web build


# --- Build ----------------------------------------------------------------
# Everything below is thrown away: only `/repo` is carried into the final image.
FROM node:${NODE_VERSION} AS builder

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
WORKDIR /repo

# Manifests first: that is what makes the install layer reusable between two
# builds where only the code changed.
#
# **All** the workspace's manifests, not just the hub's: `--frozen-lockfile`
# compares the lockfile against the whole set of projects it finds. A missing
# manifest reads as a stale lockfile, and the install fails on a message that does
# not say that.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/hub-admin/package.json apps/hub-admin/
COPY apps/hub-server/package.json apps/hub-server/
COPY apps/control-web/package.json apps/control-web/
COPY apps/room-client/package.json apps/room-client/
COPY packages/contract/package.json packages/contract/
COPY packages/db/package.json packages/db/
COPY packages/room-state/package.json packages/room-state/
COPY packages/format/package.json packages/format/
COPY packages/components/package.json packages/components/
COPY packages/hub-client/package.json packages/hub-client/
COPY packages/program/package.json packages/program/
COPY packages/ui/package.json packages/ui/

# `--prod`: no typescript, no turbo, no tests. `tsx` survives it because it is
# declared as a production dependency of the hub — which it genuinely is, since it
# is what runs the server.
#
# `--ignore-scripts`: the graph's only package with a script is `better-sqlite3`,
# and it has nothing to compile — it is a **Node-API** module shipped with one
# binary per platform. The script merely went through node-gyp to establish that,
# at the cost of a full compilation toolchain in the build image. Doing without it
# also makes the base interchangeable: see `NODE_VERSION` above.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --filter @conference-operator/hub-server...

# The sources next. `tsx` reads them as they are at start-up; `@conference-operator/ui`'s
# Tailwind sheet is committed (`src/generated/`), so there is nothing to compile
# here either.
COPY packages/ packages/
COPY apps/hub-server/ apps/hub-server/

# The two bundles, built in the previous stage. The hub serves them, it does not
# import them: that is what lets `pnpm typecheck` and `pnpm test` never trigger a
# Vite build, and CI stay under the minute.
COPY --from=spa /repo/apps/hub-admin/dist apps/hub-admin/dist
COPY --from=spa /repo/apps/control-web/dist apps/control-web/dist

# What `--prod` is not enough to rule out: a hundred megabytes or so of test and
# build tooling, which `better-auth` imposes as NON-optional peer dependencies
# (`vitest`, `drizzle-kit`, and behind them rolldown, lightningcss, happy-dom, two
# copies of esbuild). The script recomputes what the hub can actually reach from
# its sources — hence their copy just above — and deletes the rest; its header
# explains the method and its limits.
COPY scripts/prune-container-modules.mjs scripts/
RUN node scripts/prune-container-modules.mjs

# `better-sqlite3` ships one binary per platform in its npm package — eight, seven
# of which will never serve here (macOS, arm, musl). Fifteen megabytes or so not
# worth carrying. The two Linux x64 variants are kept: glibc for the image as it
# stands, musl so that a move to Alpine does not end in a module not found at
# start-up.
RUN find node_modules/.pnpm -path '*/better-sqlite3/prebuilds/*.node' \
      ! -name 'linux-x64.node' ! -name 'linuxmusl-x64.node' -delete


# --- Final image ----------------------------------------------------------
# No pnpm, no corepack, no compiler: the hub starts with `node`, and nothing else
# has any reason to be there.
FROM node:${NODE_VERSION} AS runtime

# The hub writes its SQLite database and nothing else. The default path leaves the
# code's tree: a volume mounted on `/data` survives the image being replaced,
# which a `./data` relative to the repository would not guarantee.
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

# `/health` touches neither the database nor the programme: it answers as long as
# Fastify is listening, which is exactly the question asked here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /repo/apps/hub-server

# `pnpm start` would stand between the signal and the hub: on SIGTERM, pnpm kills
# its `sh -c` wrapper and leaves the node process orphaned with its database open —
# the README describes this for development, and it is worse in a container. So
# `node` as PID 1 receives SIGTERM directly, and the hub's graceful shutdown
# (draining, WebSockets, closing the database) proceeds as intended.
CMD ["node", "--import", "tsx", "src/main.ts"]
