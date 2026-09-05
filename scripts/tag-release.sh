#!/usr/bin/env bash
#
# Publishes a version: lays down the semver tag and pushes it.
#
#   pnpm release 1.2.0        — an explicit number
#   pnpm release patch        — from the last tag (also `minor`, `major`)
#   pnpm release 1.3.0-rc.1   — a pre-release
#   pnpm release patch --dry-run
#   pnpm release 1.2.0 --yes  — without the question, for a script
#
# Pushing the tag is the **only** thing that starts `.github/workflows/release.yml`,
# and that workflow is what produces the pair a version means here: the hub image
# on GHCR and the control-room installer attached to the GitHub release. Nothing
# else has to be committed — the number lives in the tag and nowhere else, which
# is why laying it down by hand is one command and one typo away from a wrong
# release. Hence this script: it is the same two git commands, with the checks
# one would otherwise do from memory.
#
# What it refuses, and why:
#
#   - a number that is not semver, or that carries build metadata (`1.2.0+42`):
#     `+` is not a legal character in a Docker tag, and the image would be
#     published under a name nobody asked for;
#   - a tag that already exists, locally or on the remote — a published version
#     is not rewritten;
#   - a number that does not come after the last one: `docker/metadata-action`
#     moves `latest` on any stable tag, so going backwards would name an old
#     build as the current one;
#   - a dirty working tree, a branch other than `main`, or a `main` that is not
#     exactly `origin/main`: the tag would then name a commit nobody can read,
#     or one the remote does not have as its head.
#
# It does not run the tests. `release.yml` calls `ci.yml` before building
# anything, and publishes nothing behind a red suite — running them twice would
# only make this script slow enough to be bypassed.
set -euo pipefail

# Pre-release identifiers are compared byte by byte below; a locale's collation
# would make that ordering depend on the machine.
export LC_ALL=C

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Semver, minus build metadata — deliberately, see the header. Leading zeros are
# refused as the specification asks.
SEMVER='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*)?$'

# Strictly "a comes before b", in semver order. Written out rather than handed to
# `sort -V` or git's `--sort=v:refname`: both place `1.2.0-rc.1` *after* `1.2.0`,
# which is the opposite of what a release candidate means.
semver_lt() {
  local a="$1" b="$2"
  local a_core="${a%%-*}" b_core="${b%%-*}"
  local a_pre="" b_pre=""
  if [[ "$a" == *-* ]]; then a_pre="${a#*-}"; fi
  if [[ "$b" == *-* ]]; then b_pre="${b#*-}"; fi

  local -a a_numbers b_numbers
  IFS=. read -r -a a_numbers <<< "$a_core"
  IFS=. read -r -a b_numbers <<< "$b_core"
  local index
  for index in 0 1 2; do
    if (( a_numbers[index] < b_numbers[index] )); then return 0; fi
    if (( a_numbers[index] > b_numbers[index] )); then return 1; fi
  done

  # Same number: a release comes after all of its pre-releases.
  if [[ -z "$a_pre" ]]; then return 1; fi
  if [[ -z "$b_pre" ]]; then return 0; fi

  # Identifier by identifier: two numeric ones compare as numbers, a numeric one
  # ranks below an alphanumeric one, and a shorter run precedes the run that
  # starts with it — `rc.1` before `rc.1.2`.
  local -a a_parts b_parts
  IFS=. read -r -a a_parts <<< "$a_pre"
  IFS=. read -r -a b_parts <<< "$b_pre"
  local left right
  for (( index = 0; index < ${#a_parts[@]} && index < ${#b_parts[@]}; index++ )); do
    left="${a_parts[index]}"
    right="${b_parts[index]}"
    if [[ "$left" == "$right" ]]; then continue; fi
    if [[ "$left" =~ ^[0-9]+$ && "$right" =~ ^[0-9]+$ ]]; then
      if (( left < right )); then return 0; else return 1; fi
    fi
    if [[ "$left" =~ ^[0-9]+$ ]]; then return 0; fi
    if [[ "$right" =~ ^[0-9]+$ ]]; then return 1; fi
    if [[ "$left" < "$right" ]]; then return 0; else return 1; fi
  done
  if (( ${#a_parts[@]} < ${#b_parts[@]} )); then return 0; fi
  return 1
}

usage() {
  cat >&2 <<'USAGE_EOF'
Usage : pnpm release <version|patch|minor|major> [--yes] [--dry-run]

  pnpm release 1.2.0        publie v1.2.0
  pnpm release patch        incrémente le dernier tag
  pnpm release 1.3.0-rc.1   pré-version : ne déplace pas « latest »
  pnpm release patch --dry-run   affiche ce qui serait fait, sans rien poser
USAGE_EOF
}

WANTED=""
NO_QUESTION=0
DRY_RUN=0
for argument in "$@"; do
  case "$argument" in
    --yes) NO_QUESTION=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    # `pnpm release -- --yes` : pnpm laisse passer le séparateur tel quel.
    --) ;;
    -*)
      echo "Argument inconnu : $argument" >&2
      usage
      exit 2
      ;;
    *)
      if [[ -n "$WANTED" ]]; then
        echo "Une seule version attendue, reçu « $WANTED » puis « $argument »." >&2
        exit 2
      fi
      WANTED="$argument"
      ;;
  esac
done

if [[ -z "$WANTED" ]]; then
  echo "Aucune version demandée." >&2
  usage
  exit 2
fi

# The remote's view first: a tag laid down against a stale local state is the one
# mistake this script exists to catch, and every check below reads what the fetch
# brings back. `--prune-tags` so a tag deleted on the remote does not linger here
# and block a number that is in fact free.
echo "Lecture de origin…"
if ! git fetch --quiet --tags --prune --prune-tags origin; then
  echo "Impossible de lire origin — sans lui, rien ne peut être vérifié. Réseau ?" >&2
  exit 1
fi

# The highest existing tag, by semver rather than alphabetically: `v1.10.0` comes
# after `v1.9.0`, and a release candidate before its own release.
LATEST=""
while read -r tag; do
  candidate="${tag#v}"
  if [[ ! "$candidate" =~ $SEMVER ]]; then continue; fi
  if [[ -z "$LATEST" ]] || semver_lt "$LATEST" "$candidate"; then
    LATEST="$candidate"
  fi
done < <(git tag --list 'v*')

case "$WANTED" in
  major | minor | patch)
    if [[ -z "$LATEST" ]]; then
      echo "Aucun tag existant : nommer explicitement le premier numéro (par exemple 1.0.0)." >&2
      exit 2
    fi
    IFS=. read -r major minor patch <<< "${LATEST%%-*}"
    case "$WANTED" in
      major) VERSION="$((major + 1)).0.0" ;;
      minor) VERSION="$major.$((minor + 1)).0" ;;
      # A pending pre-release is finalised rather than incremented: after
      # `1.3.0-rc.2`, the next patch version *is* `1.3.0`.
      patch)
        if [[ "$LATEST" == *-* ]]; then
          VERSION="${LATEST%%-*}"
        else
          VERSION="$major.$minor.$((patch + 1))"
        fi
        ;;
    esac
    ;;
  *)
    VERSION="${WANTED#v}"
    if [[ "$VERSION" == *+* ]]; then
      echo "Les métadonnées de build (« $VERSION ») ne sont pas acceptées : « + » est interdit dans un tag Docker." >&2
      exit 2
    fi
    if [[ ! "$VERSION" =~ $SEMVER ]]; then
      echo "« $WANTED » n'est pas un numéro semver (attendu : X.Y.Z, éventuellement suivi de -rc.1)." >&2
      exit 2
    fi
    ;;
esac

TAG="v$VERSION"

if git rev-parse --verify --quiet "refs/tags/$TAG" > /dev/null; then
  echo "$TAG existe déjà — une version publiée ne se réécrit pas." >&2
  exit 1
fi

if [[ -n "$LATEST" ]] && ! semver_lt "$LATEST" "$VERSION"; then
  echo "$TAG ne vient pas après v$LATEST : « latest » désignerait une image plus ancienne." >&2
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" != "main" ]]; then
  echo "Branche « $branch » : une version se pose sur main." >&2
  exit 1
fi

# Tracked changes only. An untracked file is not in the tag and does not make it
# wrong — a leftover note or a local `.env` must not block a release.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Modifications non committées : le tag nommerait un commit qui ne les contient pas." >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

head_commit="$(git rev-parse HEAD)"
remote_head="$(git rev-parse --verify --quiet refs/remotes/origin/main || true)"
if [[ -z "$remote_head" ]]; then
  echo "origin/main est introuvable." >&2
  exit 1
fi
if [[ "$head_commit" != "$remote_head" ]]; then
  echo "main et origin/main divergent — pousser (ou tirer) avant de poser $TAG." >&2
  git --no-pager log --oneline "origin/main..HEAD" >&2 || true
  exit 1
fi

# The tag's own message. The GitHub release gets its notes from `release.yml`;
# this is what `git show v1.2.0` displays, months later, on a clone with no
# network.
if [[ -n "$LATEST" ]]; then
  range="v$LATEST..HEAD"
  history="$(git --no-pager log --reverse --format='- %s' "$range")"
else
  range=""
  history="$(git --no-pager log --reverse --format='- %s')"
fi

echo
printf 'Version   %s' "$TAG"
if [[ -n "$LATEST" ]]; then printf '   (précédente : v%s)' "$LATEST"; fi
echo
git --no-pager log -1 --format='Commit    %h %s' HEAD
if [[ -n "$history" ]]; then
  count="$(printf '%s\n' "$history" | wc -l | tr -d ' ')"
  if [[ -n "$range" ]]; then
    echo "Contenu   $count commit(s) depuis v$LATEST :"
  else
    echo "Contenu   $count commit(s) :"
  fi
  printf '%s\n' "$history" | sed 's/^/  /'
fi
echo
if [[ "$VERSION" == *-* ]]; then
  echo "Pré-version : l'image ne prendra pas « latest » et la release sera marquée pre-release."
else
  echo "Version stable : l'image prendra « latest »."
fi
echo "Poussé, ce tag lance le workflow Release : image ghcr.io + installeur Windows + release GitHub."

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "--dry-run : rien n'a été posé ni poussé."
  exit 0
fi

if [[ $NO_QUESTION -eq 0 ]]; then
  # Read from the terminal, not from standard input: called with no terminal, we
  # publish nothing rather than take an end of file for a "yes".
  answer=""
  read -r -p "Publier $TAG (o/N) ? " answer 2>/dev/null < /dev/tty || answer=""
  if [[ "$answer" != "o" && "$answer" != "O" ]]; then
    echo "Annulé — aucun tag n'a été posé."
    exit 1
  fi
fi

git tag --annotate "$TAG" --message "$TAG

$history"

# The tag is local until this line; if the push fails, it is removed rather than
# left behind to block the same number on the next attempt.
if ! git push origin "refs/tags/$TAG"; then
  git tag --delete "$TAG" > /dev/null
  echo "Échec du push — le tag local a été retiré, $TAG reste disponible." >&2
  exit 1
fi

echo
echo "$TAG poussé. Le workflow Release démarre :"

# The Actions URL, derived from whichever form the remote takes (SSH or HTTPS).
# A remote hosted elsewhere gets no invented link — the tag is pushed either way.
remote_url="$(git remote get-url origin)"
if [[ "$remote_url" == *github.com* ]]; then
  slug="${remote_url##*github.com}"
  slug="${slug#:}"
  slug="${slug#/}"
  slug="${slug%.git}"
  echo "  https://github.com/$slug/actions/workflows/release.yml"
else
  echo "  (origin n'est pas sur github.com : $remote_url)"
fi
