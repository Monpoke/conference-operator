#!/usr/bin/env bash
#
# Lance un hub et **une ou deux salles** headless, d'un seul terminal.
#
#   pnpm dev:duo    — hub + une salle
#   pnpm dev:trio   — hub + deux salles
#
# Une salle suffit pour développer une régie. Il en faut deux dès qu'on touche
# à ce qui est commun à l'événement — le mur des questions, un message poussé
# depuis la console, la modération : ces bugs-là ne se voient pas à une salle,
# il faut voir le même message arriver sur les deux écrans, ou n'arriver que
# sur un.
#
# Chaque salle a son `DATA_DIR` : c'est lui qui porte le `client-id` et le
# jeton. Partagé, les deux machines auraient la même identité et se voleraient
# leur appairage. Et son `DISPLAY_PORT`, sans quoi la seconde meurt sur
# EADDRINUSE.
#
# Les deux serveurs Vite démarrent avec le reste, et c'est nécessaire.
#
# La console et la régie sont des bundles : sans Vite, le hub et les salles
# servent le `dist/` qui traîne — celui que `pnpm test` a construit, parfois
# trois jours plus tôt. On développe alors sur une page compilée, sans
# rechargement à chaud, et l'extension Vue refuse d'inspecter ce qu'elle voit
# comme du mode production. Le symptôme ne dit pas sa cause.
#
# Variables acceptées : HUB_ORIGIN, SALLE_1, SALLE_2, PORT_1, PORT_2,
# VITE_CONSOLE, VITE_REGIE.
# Pour dérouler la journée du 30 octobre, poser `SIMULATED_TIME` dans le `.env`
# du hub : les salles s'alignent sur son heure, il n'y a rien à régler ici.
set -euo pipefail

NB_SALLES="${1:-2}"
HUB_ORIGIN="${HUB_ORIGIN:-http://localhost:8787}"
SALLE_1="${SALLE_1:-track-1-teilhard-de-chardin}"
SALLE_2="${SALLE_2:-track-2-mf-1092}"
PORT_1="${PORT_1:-7788}"
PORT_2="${PORT_2:-7789}"
# Ports figés dans les deux `vite.config.ts`, en `strictPort` : les répéter ici
# n'est pas un doublon, c'est ce que le hub et les salles doivent proxifier.
VITE_CONSOLE="${VITE_CONSOLE:-http://127.0.0.1:5173}"
VITE_REGIE="${VITE_REGIE:-http://127.0.0.1:5174}"

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Le contrôle de tâches, dans un script : chaque application lancée en
# arrière-plan obtient **son propre groupe de processus**. C'est ce qui rend
# l'arrêt propre possible, et c'est le point délicat de ce script.
#
# Sans lui, le Ctrl-C du terminal part vers tout le groupe d'un coup. Le hub le
# reçoit en même temps que le `node --watch` qui le supervise, et meurt avant
# d'avoir refermé sa base — ce que trahissent des `hub.db-wal` et `hub.db-shm`
# résiduels, exactement le symptôme qui avait fait écarter `tsx watch`. Isolées,
# les applications ne reçoivent plus que le SIGTERM que `arreter` leur adresse,
# une par une, et leur gestionnaire d'arrêt va au bout.
set -m

processus=()

# Les applications sont lancées directement, sans passer par `pnpm run`.
#
# `pnpm`, sur SIGTERM, tue son enveloppe `sh -c` et laisse le processus node
# derrière lui, orphelin et base ouverte : le signal n'atteint jamais celui qui
# a quelque chose à refermer. Il faut donc tenir le pid du processus qui tient
# la base. En contrepartie, ces lignes doublent les scripts `dev` et
# `dev:headless` des `package.json` — les garder d'accord.
demarrer() {
  local dossier="$1"
  shift
  ( cd "$dossier" && exec env "$@" ) &
  processus+=("$!")
}

vivants() {
  local pid
  for pid in "${processus[@]}"; do
    kill -0 "$pid" 2>/dev/null && return 0
  done
  return 1
}

arreter() {
  # Un second Ctrl-C pendant l'arrêt ne doit pas court-circuiter le drainage.
  trap '' INT TERM
  local pid i

  for pid in "${processus[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done

  # Puis SIGKILL, après 8 s. Le hub s'arrête en 5 s au pire — c'est son
  # échéance de drainage — mais une salle peut rester coincée dans sa
  # fermeture : elle a déjà rendu son port, et le processus, lui, ne sort
  # jamais. Sans ce filet, il faut aller le tuer à la main au lancement
  # suivant, sans savoir pourquoi le port est pris.
  for ((i = 0; i < 80; i++)); do
    vivants || break
    sleep 0.1
  done
  if vivants; then
    echo "  Arrêt forcé : une application n'a pas rendu la main en 8 s." >&2
    for pid in "${processus[@]}"; do kill -KILL "$pid" 2>/dev/null || true; done
  fi

  for pid in "${processus[@]}"; do wait "$pid" 2>/dev/null || true; done
}
trap arreter EXIT INT TERM

echo ""
echo "  Hub         ${HUB_ORIGIN}/admin"
echo "  Salle 1     http://127.0.0.1:${PORT_1}/regie      ${SALLE_1}"
[ "$NB_SALLES" -ge 2 ] && echo "  Salle 2     http://127.0.0.1:${PORT_2}/regie      ${SALLE_2}"
echo "  Mur public  ${HUB_ORIGIN}/mur?salle=${SALLE_1}"
echo ""
echo "  Code d'appairage à saisir dans la console, « Machines en attente »."
echo ""

# Vite d'abord : le hub et les salles proxifient vers lui, et une page ouverte
# avant qu'il réponde se recharge d'elle-même dès qu'il est là.
demarrer apps/hub-admin node_modules/.bin/vite
demarrer apps/regie-web node_modules/.bin/vite

demarrer apps/hub-server MODE=dev VITE_ORIGIN="$VITE_CONSOLE" \
  node --watch --env-file-if-exists=.env --import tsx src/main.ts

# Les salles démarrent tout de suite : un hub absent ne les condamne pas, elles
# le rejoignent dès qu'il répond. Il n'y a donc rien à attendre ici.
demarrer apps/room-client \
  HUB_ORIGIN="$HUB_ORIGIN" ROOM_ID="$SALLE_1" REGIE_VITE_ORIGIN="$VITE_REGIE" \
  DATA_DIR=./.donnees-locales/salle-1 DISPLAY_PORT="$PORT_1" \
  node_modules/.bin/tsx scripts/dev-headless.ts

if [ "$NB_SALLES" -ge 2 ]; then
  demarrer apps/room-client \
    HUB_ORIGIN="$HUB_ORIGIN" ROOM_ID="$SALLE_2" REGIE_VITE_ORIGIN="$VITE_REGIE" \
    DATA_DIR=./.donnees-locales/salle-2 DISPLAY_PORT="$PORT_2" \
    node_modules/.bin/tsx scripts/dev-headless.ts
fi

wait
