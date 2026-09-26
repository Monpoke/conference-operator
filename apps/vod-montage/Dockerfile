# syntax=docker/dockerfile:1

# The montage worker's image. Built from the repository root:
#
#   docker build -f apps/vod-montage/Dockerfile -t vod-montage .
#   docker run --rm -e HUB_URL=https://hub.example -e HUB_WORKER_TOKEN=wt_… \
#     -v montage-work:/work vod-montage
#
# Unlike the hub's image, not distroless: the worker drives two programs that
# have to be there — Chromium, to capture the intro and outro frame by frame,
# and ffmpeg, to encode and assemble. Both from Debian, whose packages are
# maintained; a Chromium downloaded at install time by a library would be one
# more thing to keep up to date by hand.
#
# Like the hub, no build step: `tsx` runs the sources, and the monorepo's
# layout is kept — the projector's pages and the loop's typefaces are read from
# where they sit in the tree.
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
    pnpm install --frozen-lockfile --prod --ignore-scripts --filter @conference-operator/vod-montage...

COPY tsconfig.base.json ./
# All the packages, as the hub's image does: the contract alone reaches
# room-state, format and program, and listing them here would break on the next
# import someone adds.
COPY packages/ packages/
COPY apps/vod-montage/ apps/vod-montage/
# The loop's typefaces — the same files the rooms project with, so the video
# opens on the lettering the audience saw. Free ones only (see
# packages/projector/src/server/fonts.ts).
COPY apps/room-client/assets/fonts/ apps/room-client/assets/fonts/


FROM ${BASE_IMAGE} AS runtime

# `fonts-dejavu-core`: a fallback face for a speaker's name in a script the
# loop's typefaces lack. `ca-certificates`: the hub and the storage over HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium ffmpeg fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    CHROME=/usr/bin/chromium \
    WORK_DIR=/work \
    FONTS_DIR=/repo/apps/room-client/assets/fonts

COPY --from=builder --chown=1000:1000 /repo /repo
RUN mkdir /work && chown 1000:1000 /work

# A take and its montage are downloaded and assembled here: room for two
# rushes, on a volume rather than in the container's layer.
VOLUME ["/work"]
USER 1000:1000
WORKDIR /repo/apps/vod-montage

# `node` as PID 1: SIGTERM reaches the worker, which finishes the job in hand
# rather than leaving it leased ten minutes for nobody.
ENTRYPOINT ["node", "--import", "tsx", "src/main.ts"]
