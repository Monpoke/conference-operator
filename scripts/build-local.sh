#!/usr/bin/env bash
#
# Builds a version's artifacts on a dev machine, without GitHub Actions: the
# control-room packages (Linux and Windows) and the hub image.
#
#   REGISTRY=registry.exemple.fr/cloudnord pnpm build:local
#   REGISTRY=… VERSION=1.2.0 pnpm build:local
#   REGISTRY=… PUSH=1 pnpm build:local          — also pushes the image
#   REGISTRY=… TARGETS="linux image" pnpm build:local
#
# The registry is read from the environment and nowhere else: nothing is written
# to a file, so a local build cannot leave a private registry name behind in the
# repository. Without it the script stops before building anything — an image
# tagged `hub:…` with no registry is one nobody can pull.
#
# What `release.yml` does, minus what only means something there: no tests (run
# `pnpm test` first), no attestation, no GitHub release. Windows is packaged
# through wine, which the release workflow avoids by running on Windows.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${REGISTRY:-}" ]]; then
  echo "REGISTRY manquant : REGISTRY=registry.exemple.fr/namespace pnpm build:local" >&2
  exit 2
fi
REGISTRY="${REGISTRY%/}"

# Same rule as the workflow: the number comes from git, the manifests stay at
# `0.0.0`. Off a tag, `git describe` yields `1.2.0-3-gabc1234`, which is valid
# semver (a pre-release) and a valid Docker tag.
if [[ -z "${VERSION:-}" ]]; then
  VERSION="$(git describe --tags --match 'v*' 2>/dev/null || echo "v0.0.0-local.$(git rev-parse --short HEAD)")"
  VERSION="${VERSION#v}"
fi

TARGETS="${TARGETS:-linux windows image}"
IMAGE="${REGISTRY}/hub:${VERSION}"

echo "Version   $VERSION"
echo "Cibles    $TARGETS"
echo "Image     $IMAGE"
echo

wants() { [[ " $TARGETS " == *" $1 "* ]]; }

if wants linux || wants windows; then
  # The control-room bundle travels inside the installer's `resources`: it has to
  # exist before electron-builder looks for it.
  pnpm install --frozen-lockfile
  pnpm --filter @conference-operator/control-web build
  pnpm --filter @conference-operator/room-client build
  rm -rf apps/room-client/release
fi

if wants linux; then
  pnpm --filter @conference-operator/room-client exec electron-builder \
    --linux --publish never -c.extraMetadata.version="$VERSION"
  (cd apps/room-client/release && sha256sum ./*.AppImage ./*.tar.gz | sed 's|  \./|  |' > SHA256SUMS-linux.txt)
fi

if wants windows; then
  if ! command -v wine > /dev/null; then
    echo "wine introuvable : il est nécessaire pour empaqueter Windows depuis Linux." >&2
    exit 1
  fi
  pnpm --filter @conference-operator/room-client exec electron-builder \
    --win --publish never -c.extraMetadata.version="$VERSION"
  (cd apps/room-client/release && sha256sum ./*.exe | sed 's|  \./|  |' > SHA256SUMS-windows.txt)
fi

if wants image; then
  # `linux/amd64` only, as in the workflow: the Dockerfile keeps just the x64
  # `better-sqlite3` binaries.
  docker buildx build --platform linux/amd64 \
    --tag "$IMAGE" \
    --build-arg "VERSION=$VERSION" \
    --label "org.opencontainers.image.version=$VERSION" \
    --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" \
    --load .
  if [[ "${PUSH:-0}" == "1" ]]; then
    docker push "$IMAGE"
  fi
fi

echo
if wants linux || wants windows; then
  echo "Paquets : apps/room-client/release/"
  ls -1 apps/room-client/release/ | grep -E '\.(exe|AppImage|tar\.gz|txt)$' | sed 's/^/  /'
fi
if wants image; then
  echo "Image   : $IMAGE$([[ "${PUSH:-0}" == "1" ]] && echo " (poussée)")"
fi
