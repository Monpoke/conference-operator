---
name: menage-worktrees
description: Fait le ménage dans .claude/worktrees/ — supprime les worktrees (et leurs branches locales) déjà intégrés à main et sans changement local, garde le reste avec la raison. À utiliser quand on demande de « faire le ménage », nettoyer, purger ou ranger les worktrees ou les vieilles branches.
---

# Ménage des worktrees

Le script `menage.sh` (dans ce dossier) fait tout le travail. Il se lance depuis
n'importe quel worktree du dépôt : il remonte tout seul au checkout principal.

## Déroulé

1. **Diagnostic** (ne touche à rien) :
   ```bash
   .claude/skills/menage-worktrees/menage.sh
   ```
2. Lire la liste « À supprimer ». Si rien d'anormal, **appliquer** :
   ```bash
   .claude/skills/menage-worktrees/menage.sh --apply
   ```
   Une demande explicite de ménage autorise directement le `--apply` ; pas besoin de
   redemander confirmation pour ce qui est classé supprimable.
3. Rapporter : combien de worktrees supprimés, et la liste « Conservés » avec la raison
   de chacun, pour que l'utilisateur décide (committer, merger ou jeter).

`--base=<branche>` change la branche de référence (par défaut `main`).

## Règles de sûreté (appliquées par le script)

Un worktree n'est supprimé que si **toutes** ces conditions tiennent :

- sa branche est intégrée à `main` : ancêtre de main, ou tous ses patchs déjà présents
  (`git cherry`) ;
- `git status --porcelain` est vide : aucun fichier modifié ni non suivi (les fichiers
  ignorés, comme `node_modules` ou `dist`, partent avec le worktree) ;
- il n'est pas verrouillé (`git worktree lock`) ;
- aucun processus n'a son répertoire courant dedans : c'est peut-être une session Claude
  ou un serveur de dev en cours.

Sa branche locale est supprimée avec lui. Avec `--apply`, les branches locales déjà
intégrées à main qui n'ont plus de worktree sont aussi supprimées (`git branch -d`).

## Ce que le script ne fait jamais

- Supprimer un worktree conservé, même si l'utilisateur dit « tout ». Dans ce cas, montrer
  ce qu'il contient (`git -C <path> status`, `git log main..<branche>`) et demander
  au cas par cas, ou committer d'abord.
- Supprimer des branches distantes (`origin/*`). C'est une action visible par les autres :
  la proposer seulement, avec la liste `git branch -r --merged main`.
- Toucher au worktree de la session en cours (il est protégé par la règle « processus
  actif dedans »).
