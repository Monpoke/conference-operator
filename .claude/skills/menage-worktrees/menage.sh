#!/usr/bin/env bash
# Ménage des worktrees .claude/worktrees/ : diagnostic par défaut, --apply pour supprimer.
# Supprimé seulement si : branche intégrée à main (ancêtre ou patchs déjà dans main),
# aucun changement local (suivi ou non suivi), pas verrouillé, aucun processus dedans.
set -euo pipefail

APPLY=0
BASE=main
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --base=*) BASE="${arg#--base=}" ;;
    *) echo "usage: $0 [--apply] [--base=main]" >&2; exit 2 ;;
  esac
done

ROOT="$(git rev-parse --path-format=absolute --git-common-dir | sed 's#/\.git$##')"
cd "$ROOT"
git worktree prune

# Répertoires courants de tous les processus (pour ne pas couper une session active)
CWDS="$(for p in /proc/[0-9]*; do readlink "$p/cwd" 2>/dev/null || true; done | sort -u)"

removed=(); kept=()
while IFS=$'\t' read -r path branch locked; do
  [[ "$path" == "$ROOT/.claude/worktrees/"* ]] || continue
  name="${path#$ROOT/.claude/worktrees/}"
  reason=""

  if [[ "$locked" == 1 ]]; then
    reason="verrouillé"
  elif [[ -z "$branch" ]]; then
    reason="HEAD détaché"
  elif grep -q "^$path\(/\|$\)" <<<"$CWDS"; then
    reason="processus actif dedans"
  elif [[ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]]; then
    reason="changements non commités ($(git -C "$path" status --porcelain | wc -l) fichiers)"
  elif ! git merge-base --is-ancestor "$branch" "$BASE"; then
    ahead=$(git cherry "$BASE" "$branch" | grep -c '^+' || true)
    [[ "$ahead" -gt 0 ]] && reason="$ahead commit(s) absent(s) de $BASE"
  fi

  if [[ -n "$reason" ]]; then
    kept+=("$(printf '%-38s %-40s %s' "$name" "$branch" "$reason")")
    continue
  fi

  removed+=("$(printf '%-38s %s' "$name" "$branch")")
  if [[ $APPLY == 1 ]]; then
    git worktree remove "$path"
    # -D : intégration déjà vérifiée ci-dessus (y compris par patch-id, que -d ne voit pas)
    git branch -D "$branch" >/dev/null
  fi
done < <(git worktree list --porcelain | awk '
  /^worktree /{ if (p) print p "\t" b "\t" l; p=substr($0,10); b=""; l=0 }
  /^branch /{ b=substr($0,8); sub("refs/heads/","",b) }
  /^locked/{ l=1 }
  END{ if (p) print p "\t" b "\t" l }')

verb=$([[ $APPLY == 1 ]] && echo "Supprimés" || echo "À supprimer (relancer avec --apply)")
echo "== $verb : ${#removed[@]}"
[[ ${#removed[@]} -gt 0 ]] && printf "  %s\n" "${removed[@]}"
echo "== Conservés : ${#kept[@]}"
[[ ${#kept[@]} -gt 0 ]] && printf "  %s\n" "${kept[@]}"

# Branches locales sans worktree déjà intégrées (info seulement)
wt_branches="$(git worktree list --porcelain | sed -n 's#^branch refs/heads/##p')"
orphans=$(git branch --merged "$BASE" --format='%(refname:short)' | grep -vx "$BASE" | grep -vxF -f <(echo "$wt_branches") || true)
if [[ -n "$orphans" ]]; then
  if [[ $APPLY == 1 ]]; then
    echo "== Branches locales intégrées sans worktree supprimées :"
    for b in $orphans; do git branch -d "$b" >/dev/null && echo "  $b"; done
  else
    echo "== Branches locales intégrées sans worktree (supprimées avec --apply) :"
    printf '  %s\n' $orphans
  fi
fi
