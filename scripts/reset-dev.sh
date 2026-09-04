#!/usr/bin/env bash
#
# Erases the local development databases and data.
#
#   pnpm reset:dev         — lists, asks for confirmation, deletes
#   pnpm reset:dev --yes   — without the question, for a script
#
# What goes: the hub's database, the rooms' databases, their paired identity
# (`client-id`, `jeton`), the remembered hub address, the asset cache and the
# simulated recordings. In other words, everything that makes a development
# environment remember yesterday — and nothing else.
#
# What stays: the `.env` files, the migrations, the build outputs. These are not
# data, and regenerating them does not cost the same.
#
# Electron's data folder is **not deleted wholesale**. Outside packaging, Electron
# names that folder "Electron": it is shared with any other unpackaged Electron
# application launched on this machine. So we only remove, by name, the files the
# room writes there.
#
# Stop the applications first: deleting an open database leaves the process
# working on an unlinked file, and it will rewrite part of what was just erased as
# it closes.
#
# On Windows, the installed control machine keeps its own under
# `%APPDATA%\Régie de salle` — out of this script's reach, run on the Unix side.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NO_QUESTION=0
for argument in "$@"; do
  case "$argument" in
    --yes) NO_QUESTION=1 ;;
    # `pnpm reset:dev -- --yes`: pnpm passes the separator through as is, and
    # choking on it would break the form everybody types by reflex.
    --) ;;
    *)
      echo "Argument inconnu : $argument (le seul attendu est --yes)" >&2
      exit 2
      ;;
  esac
done

# What a room writes into its data folder. Kept in step with `room-app.ts`
# (database and assets) and `main/index.ts` (identity, token, hub address,
# simulated recordings): a file added over there and forgotten here means a reset
# that is no longer one. The names themselves are on-disk names, not renamed.
ROOM_FILES=(salle.db salle.db-wal salle.db-shm client-id jeton hub assets enregistrements)

# The two names the client runs under: "Electron" from the sources, the product's
# name once installed.
APPLICATIONS=(Electron "Régie de salle")

targets=()
add() { if [[ -e "$1" ]]; then targets+=("$1"); fi }

# The hub's database, and its whole folder: `data/` is ignored by git and holds
# nothing else.
add apps/hub-server/data

# Headless rooms: `pnpm dev:headless`, `dev:duo`, `dev:trio`.
add apps/room-client/.local-data

# Electron rooms, in the system's data folder.
for root in "$HOME/.config" "$HOME/Library/Application Support"; do
  for application in "${APPLICATIONS[@]}"; do
    for file in "${ROOM_FILES[@]}"; do
      add "$root/$application/$file"
    done
  done
done

if [[ ${#targets[@]} -eq 0 ]]; then
  echo "Rien à supprimer : les données de développement sont déjà propres."
  exit 0
fi

echo "À supprimer :"
for target in "${targets[@]}"; do
  printf '  %-6s %s\n' "$(du -sh "$target" | cut -f1)" "$target"
done
echo
echo "Les salles perdront leur appairage et devront être réapprouvées dans la console."

if [[ $NO_QUESTION -eq 0 ]]; then
  # Read from the terminal, not from standard input: called with no terminal, we
  # erase nothing rather than take an end of file for a "yes".
  answer=""
  # `2>` before `<`: the redirections are laid down left to right, and a missing
  # /dev/tty would complain before its complaint could be diverted.
  read -r -p "Confirmer (o/N) ? " answer 2>/dev/null < /dev/tty || answer=""
  if [[ "$answer" != "o" && "$answer" != "O" ]]; then
    echo "Annulé — rien n'a été supprimé."
    exit 1
  fi
fi

rm -rf -- "${targets[@]}"
echo "Supprimé."
