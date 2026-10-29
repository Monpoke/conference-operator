# syntax=docker/dockerfile:1

# The public social page's image. Built from the repository root:
#
#   docker build -f apps/mur-public/Dockerfile -t mur-public .
#   docker run --rm -p 8080:8080 -e HUB_URL=http://hub:8787 mur-public
#
# Like the montage worker: no build step, `tsx` runs the sources, and the
# monorepo's layout is kept. Nothing but Node: the page has no dependency of its
# own to install on the system.
ARG BASE_IMAGE=node:24-trixie-slim

FROM ${BASE_IMAGE} AS builder
ENV PNPM_HOME=/pnpm CI=true
RUN npm install -g pnpm@12.4.1
WORKDIR /repo

# All the workspace's manifests: `--frozen-lockfile` checks the lockfile against
# the whole set of projects it finds (see the hub's Dockerfile).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/hub-admin/package.json apps/hub-admin/
COPY apps/hub-server/package.json apps/hub-server/
COPY apps/control-web/package.json apps/control-web/
COPY apps/room-client/package.json apps/room-client/
COPY apps/vod-montage/package.json apps/vod-montage/
COPY apps/mur-public/package.json apps/mur-public/
COPY packages/contract/package.json packages/contract/
COPY packages/db/package.json packages/db/
COPY packages/room-state/package.json packages/room-state/
COPY packages/format/package.json packages/format/
COPY packages/components/package.json packages/components/
COPY packages/hub-client/package.json packages/hub-client/
COPY packages/program/package.json packages/program/
COPY packages/projector/package.json packages/projector/
COPY packages/ui/package.json packages/ui/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --filter @conference-operator/mur-public...

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/mur-public/ apps/mur-public/


FROM ${BASE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=8080
COPY --from=builder --chown=1000:1000 /repo /repo
USER 1000:1000
WORKDIR /repo/apps/mur-public
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/sante').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# `node` as PID 1: SIGTERM reaches the server, which closes its sockets.
ENTRYPOINT ["node", "--import", "tsx", "src/main.ts"]
