#!/usr/bin/env bash
#
# Starts a hub and **one or two headless rooms**, from a single terminal.
#
#   pnpm dev:duo    — hub + one room
#   pnpm dev:trio   — hub + two rooms
#
# Adding `--electron` replaces the **first** room with the real Electron client,
# the one used on the day. What that buys: the windows, the "Écrans" menu that
# places the projection full screen on the right output, the VOD folder picker,
# the token vault — everything `dev-headless` cannot render, and which is
# therefore exercised nowhere else.
#
#   pnpm dev:duo --electron    — hub + one Electron room
#   pnpm dev:trio --electron   — hub + one Electron room + one headless room
#
# Under WSL, WSLg or an X server is required: without one no window opens, and
# nothing says so clearly. That is why the default stays headless.
#
# One room is enough to develop a control app. Two are needed as soon as one
# touches what is shared across the event — the questions wall, a message pushed
# from the console, moderation: those bugs are invisible with one room, one has to
# see the same message arrive on both screens, or arrive on only one.
#
# Each room has its own `DATA_DIR`: that is what carries the `client-id` and the
# token. Shared, the two machines would have the same identity and would steal
# each other's pairing. And its own `DISPLAY_PORT`, failing which the second dies
# on EADDRINUSE.
#
# Both Vite servers start with the rest, silent, and that is necessary.
#
# The console and the control app are bundles: with no Vite, the hub and the rooms
# serve whatever `dist/` is lying around — the one `pnpm test` built, sometimes
# three days earlier. One then develops against a compiled page, with no hot
# reload, and the Vue extension refuses to inspect what it sees as production
# mode. The symptom does not say its cause.
#
# Silent, because Vite clears the screen at start-up **and on every reload**: two
# of them in a terminal shared with a hub and two rooms wiped out the banner below
# and everything the others had written. `--logLevel warn` removes its health
# bulletin — "ready in 330 ms", one line per reloaded module — and keeps what
# matters: its errors.
#
# Variables accepted: HUB_ORIGIN, ROOM_1, ROOM_2, PORT_1, PORT_2, VITE_CONSOLE,
# VITE_CONTROL, OBS_REEL, SIMULATED_TIME.
#
# `OBS_REEL=1` plugs the rooms into real obs-websocket instances instead of the
# simulator. Careful with two rooms: they are provisioned with the same default
# addresses (`ws://127.0.0.1:4455` and `:4456`), and would therefore drive the same
# two instances believing themselves alone. Giving them distinct ports is done in
# the console's Réglages.
# To run through the 30 October day, `SIMULATED_TIME` — either in the hub's `.env`
# or in front of this command for one run: the environment variable wins, since
# `node --env-file-if-exists` never overwrites what is already set.
#
#   SIMULATED_TIME=2026-10-30T10:20:00Z pnpm dev:duo
#
# On the **hub** and not on the rooms: they align on its time, so there is nothing
# to set on their side. `dev-headless`'s `HEURE_SIMULEE` only serves working with
# no hub — as soon as a hub answers it is ignored, and setting both would make two
# clocks that everything else compares drift apart.
set -euo pipefail

ROOM_COUNT=2
ELECTRON=0
for argument in "$@"; do
  case "$argument" in
    --electron) ELECTRON=1 ;;
    [0-9]*) ROOM_COUNT="$argument" ;;
    *)
      echo "  Argument inconnu : ${argument}" >&2
      echo "  Attendus : un nombre de salles, et --electron." >&2
      exit 1
      ;;
  esac
done

HUB_ORIGIN="${HUB_ORIGIN:-http://localhost:8787}"
ROOM_1="${ROOM_1:-track-1-teilhard-de-chardin}"
ROOM_2="${ROOM_2:-track-2-mf-1092}"
PORT_1="${PORT_1:-7788}"
PORT_2="${PORT_2:-7789}"
# The two Vite servers' origins, and **a single source** for each: the port Vite
# listens on is deduced from it and passed on the command line. The
# `vite.config.ts` files carry the same defaults; repeating them here without
# tying them together would let `VITE_CONTROL=…:5185` move what the room proxies
# without moving what Vite serves.
VITE_CONSOLE="${VITE_CONSOLE:-http://127.0.0.1:5173}"
VITE_CONTROL="${VITE_CONTROL:-http://127.0.0.1:5174}"

port_of() {
  local rest="${1##*:}"
  echo "${rest%%/*}"
}

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The ports are checked **before** anything is started.
#
# Without this, an application dies on EADDRINUSE in a corner of the terminal and
# the script carries on: the hub then proxies to whatever occupies the port, and
# serves 404s that nothing ties back to the cause. It happened — a Vite launched at
# the repository root, left there for seventeen hours, served `/@vite/client` when
# the console asked for `/admin/@vite/client`. The error message spoke of the
# console; the culprit was a process forgotten the day before.
# Who holds a port, with its age: it is the age that gives the oversight away.
# Silent if the network tools are missing — the port is still reported, only the
# culprit's name is absent.
# The listening ports, read once from the kernel's table.
#
# And not by attempting a connection: `/dev/tcp` hangs indefinitely in some
# environments instead of refusing, and a check that blocks is worse than no check
# — it turns a taken port into a script that never starts, without a word.
listening() {
  ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || true
}

check_ports() {
  local table port line pid free=1
  table="$(listening)"

  # A check that cannot check must say so, not stay silent: with no network tool,
  # what follows verifies nothing.
  if [ -z "$table" ]; then
    echo "  Ni ss ni netstat : les ports ne sont pas vérifiés." >&2
    return 0
  fi

  for port in "$@"; do
    line="$(grep -E "[0-9.:]:${port}[[:space:]]" <<<"$table" | head -1 || true)"
    [ -z "$line" ] && continue
    free=0
    echo "  Port ${port} déjà pris." >&2
    # The age, because it is what gives the oversight away: a process from
    # yesterday belongs to no session under way.
    pid="$(grep -oE 'pid=[0-9]+' <<<"$line" | head -1 | cut -d= -f2 || true)"
    [ -n "$pid" ] && ps -o pid=,etimes=,cmd= -p "$pid" 2>/dev/null | head -1 >&2
  done

  if [ "$free" -eq 0 ]; then
    echo "" >&2
    echo "  Rien n'est lancé. Arrêtez ce qui occupe ces ports — souvent une" >&2
    echo "  session précédente — puis relancez." >&2
    echo "" >&2
    exit 1
  fi
}

# Job control, inside a script: every application started in the background gets
# **its own process group**. That is what makes a clean shutdown possible, and it
# is this script's delicate point.
#
# Without it, the terminal's Ctrl-C goes to the whole group at once. The hub
# receives it at the same time as the `node --watch` supervising it, and dies
# before closing its database — which leftover `hub.db-wal` and `hub.db-shm` files
# give away, exactly the symptom that had ruled out `tsx watch`. Isolated, the
# applications now only receive the SIGTERM `shutdown` sends them, one by one, and
# their shutdown handler runs to the end.
set -m

processes=()

# The applications are started directly, without going through `pnpm run`.
#
# `pnpm`, on SIGTERM, kills its `sh -c` wrapper and leaves the node process behind
# it, orphaned with its database open: the signal never reaches the one that has
# something to close. So the pid of the process holding the database has to be
# held. In exchange, these lines duplicate the `dev` and `dev:headless` scripts in
# the `package.json` files — keep them in step.
start() {
  local folder="$1"
  shift
  ( cd "$folder" && exec env "$@" ) &
  processes+=("$!")
}

alive() {
  local pid
  for pid in "${processes[@]}"; do
    kill -0 "$pid" 2>/dev/null && return 0
  done
  return 1
}

shutdown() {
  # A second Ctrl-C during the shutdown must not short-circuit the draining.
  trap '' INT TERM
  local pid i

  for pid in "${processes[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done

  # Then SIGKILL, after 8 s. The hub stops within 5 s at worst — that is its
  # draining deadline — but a room can get stuck in its shutdown: it has already
  # given its port back, and the process itself never exits. Without this net, one
  # has to go and kill it by hand at the next launch, with no idea why the port is
  # taken.
  for ((i = 0; i < 80; i++)); do
    alive || break
    sleep 0.1
  done
  if alive; then
    echo "  Arrêt forcé : une application n'a pas rendu la main en 8 s." >&2
    for pid in "${processes[@]}"; do kill -KILL "$pid" 2>/dev/null || true; done
  fi

  for pid in "${processes[@]}"; do wait "$pid" 2>/dev/null || true; done
}
trap shutdown EXIT INT TERM

# Electron reads neither `DATA_DIR` nor `DISPLAY_PORT`.
#
# Its data folder is the system's (`app.getPath('userData')`) — the same one `pnpm
# dev` and `pnpm reset:dev` know how to clean, which is why it is not moved here: an
# Electron room stored elsewhere would survive a reset with nobody understanding
# why it is still paired. And its display port is pinned to 7788 in the main
# process. `PORT_1` therefore commands nothing, and saying so beats letting people
# believe otherwise.
PORT_ELECTRON=7788
if [ "$ELECTRON" -eq 1 ]; then
  if [ "$PORT_1" != "$PORT_ELECTRON" ]; then
    echo "  PORT_1 ignoré : la salle Electron sert toujours sur ${PORT_ELECTRON}." >&2
  fi
  PORT_1="$PORT_ELECTRON"
fi

PORTS=("$(port_of "$VITE_CONSOLE")" "$(port_of "$VITE_CONTROL")" "$PORT_1")
[ "$ROOM_COUNT" -ge 2 ] && PORTS+=("$PORT_2")
# The hub takes its port from its own configuration, not from here — but
# `HUB_ORIGIN` names it, and it is the one everybody points at. Ignored if the
# origin carries none: the check must not invent a port in order to refuse.
PORT_HUB="$(port_of "$HUB_ORIGIN")"
[[ "$PORT_HUB" =~ ^[0-9]+$ ]] && PORTS+=("$PORT_HUB")
check_ports "${PORTS[@]}"

# The main process's bundle, before anything is launched.
#
# `tsx` does not run inside Electron: the main process has to be bundled as
# CommonJS. Done here rather than in an `&&` of the launched command, because
# `start` performs a single `exec` — and because a build failure must stop the
# script, not leave a hub running in front of a room that does not exist.
if [ "$ELECTRON" -eq 1 ]; then
  echo ""
  echo "  Bundle du processus principal…"
  ( cd apps/room-client && node scripts/build-main.mjs )
fi

echo ""
echo "  Hub         ${HUB_ORIGIN}/admin"
if [ "$ELECTRON" -eq 1 ]; then
  echo "  Salle 1     Electron — fenêtre de régie      ${ROOM_1}"
  echo "              écrans aussi sur http://127.0.0.1:${PORT_1}/"
  echo "              dossier de données du système, pas ./.local-data"
else
  echo "  Salle 1     http://127.0.0.1:${PORT_1}/regie      ${ROOM_1}"
fi
[ "$ROOM_COUNT" -ge 2 ] && echo "  Salle 2     http://127.0.0.1:${PORT_2}/regie      ${ROOM_2}"
echo "  Mur public  ${HUB_ORIGIN}/mur?salle=${ROOM_1}"
echo "  Régie mobile ${HUB_ORIGIN}/regie" 
echo ""
# The two Vite servers no longer announce themselves: we do it for them, failing
# which nothing on screen says they are running — nor where to look if they fall.
echo "  Vite        ${VITE_CONSOLE} console · ${VITE_CONTROL} régie"
echo "              muets tant que tout va ; leurs erreurs, elles, passent."
echo ""
echo "  Code d'appairage à saisir dans la console, « Machines en attente »."
echo ""

# Vite first: the hub and the rooms proxy to it, and a page opened before it
# answers reloads by itself as soon as it is there.
start apps/hub-admin node_modules/.bin/vite \
  --port "$(port_of "$VITE_CONSOLE")" --strictPort --clearScreen false --logLevel warn
start apps/control-web node_modules/.bin/vite \
  --port "$(port_of "$VITE_CONTROL")" --strictPort --clearScreen false --logLevel warn

# The hub proxies **both** Vite servers: the console's, and the control app's —
# which it also serves, for the mobile control app. The same server suits both
# hosts, since both serve the control app under `/regie/`.
#
# No `DEVICE_CODE_TTL` here any more. This script used to raise it, because two
# minutes were not enough for what it does on every launch — pair one room, then
# a second, the first code dying before the second was approved. The default is
# now ten minutes, which covers it; and a development hub that runs on another
# expiry than the real one is a development hub that lies about this exact bug.
start apps/hub-server MODE=dev VITE_ORIGIN="$VITE_CONSOLE" REGIE_VITE_ORIGIN="$VITE_CONTROL" \
  node --watch --env-file-if-exists=.env --import tsx src/main.ts

# The rooms start straight away: a missing hub does not condemn them, they join it
# as soon as it answers. So there is nothing to wait for here.
if [ "$ELECTRON" -eq 1 ]; then
  # An explicit `MODE=dev`, and it is the difference that costs dearly.
  #
  # `dev-headless.ts` puts itself into development — that is what it is for.
  # Electron's main process, on the other hand, reads the raw environment: without
  # this variable it starts in production, waits for two real OBS instances, and
  # shows no warning to say so.
  start apps/room-client \
    MODE=dev HUB_ORIGIN="$HUB_ORIGIN" ROOM_ID="$ROOM_1" REGIE_VITE_ORIGIN="$VITE_CONTROL" \
    node_modules/.bin/electron dist/main.cjs
else
  start apps/room-client \
    HUB_ORIGIN="$HUB_ORIGIN" ROOM_ID="$ROOM_1" REGIE_VITE_ORIGIN="$VITE_CONTROL" \
    DATA_DIR=./.local-data/room-1 DISPLAY_PORT="$PORT_1" \
    node_modules/.bin/tsx scripts/dev-headless.ts
fi

if [ "$ROOM_COUNT" -ge 2 ]; then
  start apps/room-client \
    HUB_ORIGIN="$HUB_ORIGIN" ROOM_ID="$ROOM_2" REGIE_VITE_ORIGIN="$VITE_CONTROL" \
    DATA_DIR=./.local-data/room-2 DISPLAY_PORT="$PORT_2" \
    node_modules/.bin/tsx scripts/dev-headless.ts
fi

wait
