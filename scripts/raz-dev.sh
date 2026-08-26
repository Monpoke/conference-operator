#!/usr/bin/env bash
#
# Efface les bases et les données locales de développement.
#
#   pnpm raz:dev         — liste, demande confirmation, supprime
#   pnpm raz:dev --oui   — sans la question, pour un script
#
# Ce qui part : la base du hub, celles des salles, leur identité appairée
# (`client-id`, `jeton`), l'adresse de hub mémorisée, le cache d'assets et les
# captations simulées. Autrement dit, tout ce qui fait qu'un environnement de
# développement se souvient d'hier — et rien d'autre.
#
# Ce qui reste : les `.env`, les migrations, les sorties de build. Ce ne sont
# pas des données, et les régénérer n'a pas le même prix.
#
# Le dossier de données d'Electron **n'est pas supprimé en bloc**. Hors
# empaquetage, Electron nomme ce dossier « Electron » : il est partagé avec
# toute autre application Electron non empaquetée lancée sur cette machine.
# On n'y retire donc que les fichiers que la salle y écrit, nommément.
#
# Arrêter les applications avant : supprimer une base ouverte laisse le
# processus travailler sur un fichier délié, et il réécrira en partie ce qu'on
# vient d'effacer en se fermant.
#
# Sous Windows, le poste de régie installé range les siennes dans
# `%APPDATA%\Régie de salle` — hors de portée de ce script, lancé côté Unix.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SANS_QUESTION=0
for argument in "$@"; do
  case "$argument" in
    --oui) SANS_QUESTION=1 ;;
    # `pnpm raz:dev -- --oui` : pnpm transmet le séparateur tel quel, et s'en
    # étrangler ferait échouer la forme que tout le monde tape par réflexe.
    --) ;;
    *)
      echo "Argument inconnu : $argument (le seul attendu est --oui)" >&2
      exit 2
      ;;
  esac
done

# Ce qu'une salle écrit dans son dossier de données. Tenu à jour avec
# `room-app.ts` (base et assets) et `main/index.ts` (identité, jeton, adresse
# du hub, captations simulées) : un fichier ajouté là-bas et oublié ici, c'est
# une remise à zéro qui n'en est plus une.
FICHIERS_SALLE=(salle.db salle.db-wal salle.db-shm client-id jeton hub assets enregistrements)

# Les deux noms sous lesquels le client tourne : « Electron » depuis les
# sources, le nom du produit une fois installé.
APPLICATIONS=(Electron "Régie de salle")

cibles=()
ajouter() { if [[ -e "$1" ]]; then cibles+=("$1"); fi }

# Base du hub, et son dossier entier : `data/` est ignoré par git et ne
# contient que ça.
ajouter apps/hub-server/data

# Salles headless : `pnpm dev:headless`, `dev:duo`, `dev:trio`.
ajouter apps/room-client/.donnees-locales

# Salles Electron, dans le dossier de données du système.
for racine in "$HOME/.config" "$HOME/Library/Application Support"; do
  for application in "${APPLICATIONS[@]}"; do
    for fichier in "${FICHIERS_SALLE[@]}"; do
      ajouter "$racine/$application/$fichier"
    done
  done
done

if [[ ${#cibles[@]} -eq 0 ]]; then
  echo "Rien à supprimer : les données de développement sont déjà propres."
  exit 0
fi

echo "À supprimer :"
for cible in "${cibles[@]}"; do
  printf '  %-6s %s\n' "$(du -sh "$cible" | cut -f1)" "$cible"
done
echo
echo "Les salles perdront leur appairage et devront être réapprouvées dans la console."

if [[ $SANS_QUESTION -eq 0 ]]; then
  # Lu sur le terminal, pas sur l'entrée standard : appelé sans terminal, on
  # n'efface rien plutôt que de prendre une fin de fichier pour un « oui ».
  reponse=""
  # `2>` avant `<` : les redirections sont posées de gauche à droite, et un
  # /dev/tty absent se plaindrait avant que sa plainte ne soit détournée.
  read -r -p "Confirmer (o/N) ? " reponse 2>/dev/null < /dev/tty || reponse=""
  if [[ "$reponse" != "o" && "$reponse" != "O" ]]; then
    echo "Annulé — rien n'a été supprimé."
    exit 1
  fi
fi

rm -rf -- "${cibles[@]}"
echo "Supprimé."
