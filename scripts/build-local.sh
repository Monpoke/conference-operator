#!/usr/bin/env bash
#
# Builds a version's artifacts on a dev machine, without GitHub Actions: the
# control-room packages (Linux and Windows) and the hub image.
#
#   REGISTRY=registry.exemple.fr/cloudnord pnpm build:local
#   REGISTRY=… VERSION=1.2.0 pnpm build:local
#   REGISTRY=… PUSH=1 pnpm build:local          — also pushes the image
#   REGISTRY=… TARGETS="linux image" pnpm build:local
#   REGISTRY=… pnpm build:local k8s             — image, pushed, StatefulSet patched
#
# The registry is read from the environment and nowhere else: nothing is written
# to a file, so a local build cannot leave a private registry name behind in the
# repository. Without it the script stops before building anything — an image
# tagged `hub:…` with no registry is one nobody can pull.
#
# What `release.yml` does, minus what only means something there: no tests (run
# `pnpm test` first), no attestation, no GitHub release. Windows is packaged
# through wine, which the release workflow avoids by running on Windows.
#
# `k8s` is the argument for the loop one actually runs between two builds: build
# the image, push it, and point the running StatefulSet at *that* build. It pins
# the digest rather than the tag — see the comment above `kubectl set image`.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

K8S=0
for arg in "$@"; do
  case "$arg" in
    k8s) K8S=1 ;;
    *)
      echo "argument inconnu : $arg (seul « k8s » existe)" >&2
      exit 2
      ;;
  esac
done

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

# Deploying means the image and nothing else: the control-room packages have no
# part in a cluster, and Windows would ask for wine on the way past.
if (( K8S )); then
  TARGETS="${TARGETS:-image}"
  PUSH=1
fi

TARGETS="${TARGETS:-linux windows image}"
IMAGE="${REGISTRY}/hub:${VERSION}"

KUBE_NAMESPACE="${KUBE_NAMESPACE:-conference-operator}"
# `kind/name`, as `kubectl set image` and `rollout status` both take it. The hub
# is a StatefulSet — it carries a SQLite file, see `manifests/statefulset.yaml`.
KUBE_WORKLOAD="${KUBE_WORKLOAD:-statefulset/hub}"
# The container's name inside the pod, which `set image` addresses — it is `hub`
# in `manifests/statefulset.yaml`.
KUBE_CONTAINER="${KUBE_CONTAINER:-hub}"
# Empty means the current context. Named, it is passed to every `kubectl` call:
# a deploy that lands on yesterday's cluster is the mistake this variable exists
# to keep from happening silently.
KUBE_CONTEXT="${KUBE_CONTEXT:-}"
kube=(kubectl --namespace "$KUBE_NAMESPACE")
if [[ -n "$KUBE_CONTEXT" ]]; then
  kube+=(--context "$KUBE_CONTEXT")
fi

echo "Version   $VERSION"
echo "Cibles    $TARGETS"
echo "Image     $IMAGE"
if (( K8S )); then
  echo "Cluster   ${KUBE_CONTEXT:-contexte courant} · $KUBE_WORKLOAD (namespace $KUBE_NAMESPACE)"
fi
echo

wants() { [[ " $TARGETS " == *" $1 "* ]]; }

# Checked before the build rather than after it: a missing `kubectl`, or a
# cluster nobody can reach, is worth knowing now and not in ten minutes.
if (( K8S )); then
  if ! wants image; then
    echo "k8s demande la cible « image » : TARGETS=\"$TARGETS\" ne la contient pas." >&2
    exit 2
  fi
  if ! command -v kubectl > /dev/null; then
    echo "kubectl introuvable : il est nécessaire pour patcher la charge de travail." >&2
    exit 1
  fi
  # `--request-timeout`: without it, an unreachable API server keeps kubectl
  # waiting, and the check meant to fail fast is the one thing that hangs.
  if ! "${kube[@]}" --request-timeout=10s get "$KUBE_WORKLOAD" > /dev/null 2>&1; then
    echo "$KUBE_WORKLOAD introuvable dans le namespace $KUBE_NAMESPACE (ou cluster injoignable)." >&2
    exit 1
  fi
fi

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

DIGEST=""

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
    # Read back from the registry rather than from the local daemon: this is the
    # digest of what was actually stored there, and it is what the cluster pulls.
    DIGEST="$(docker buildx imagetools inspect "$IMAGE" --format '{{.Manifest.Digest}}')"
  fi
fi

PINNED=""

if (( K8S )); then
  if [[ -z "$DIGEST" ]]; then
    echo "Digest introuvable après le push : rien n'a été touché sur le cluster." >&2
    exit 1
  fi
  PINNED="${REGISTRY}/hub@${DIGEST}"

  # The digest, not the tag. Between two local builds the tag does not move —
  # `git describe` gives the same string until the next commit — so a workload
  # already carrying it would be left untouched: same image field, no new
  # revision, nothing rolled out. The digest changes at every build, which is
  # what makes the patch mean « run this one ». It also settles the question of
  # `imagePullPolicy: IfNotPresent` keeping an older image behind a reused tag.
  "${kube[@]}" set image "$KUBE_WORKLOAD" "$KUBE_CONTAINER=$PINNED"
  # A StatefulSet's rolling update terminates `hub-0` before starting its
  # replacement — never two writers on the SQLite file, and a few seconds of
  # interruption. Waiting here is what keeps a green command from covering a pod
  # stuck on its migrations.
  "${kube[@]}" rollout status "$KUBE_WORKLOAD" --timeout=5m
fi

echo
if wants linux || wants windows; then
  echo "Paquets : apps/room-client/release/"
  ls -1 apps/room-client/release/ | grep -E '\.(exe|AppImage|tar\.gz|txt)$' | sed 's/^/  /'
fi
if wants image; then
  echo "Image   : $IMAGE$([[ "${PUSH:-0}" == "1" ]] && echo " (poussée)")"
fi
if (( K8S )); then
  echo "Déployé : $PINNED"
  echo "          → $KUBE_WORKLOAD, namespace $KUBE_NAMESPACE${KUBE_CONTEXT:+, contexte $KUBE_CONTEXT}"
fi
