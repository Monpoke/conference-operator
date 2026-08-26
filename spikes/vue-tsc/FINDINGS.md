# `vue-tsc` et TypeScript 7 — ce que le spike a établi

Mesuré le 26/08/2026, dans ce dépôt, avec `vue-tsc@3.3.11`.

## Le fait

**`vue-tsc` ne démarre pas sur TypeScript 7.** Pas « il type moins bien » :
il s'arrête avant d'avoir lu un seul fichier.

```
$ pnpm exec vue-tsc --noEmit          # avec typescript@7.0.2
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]:
  Package subpath './lib/tsc' is not defined by "exports" in .../typescript/package.json
```

La cause est structurelle. `vue-tsc` n'appelle pas `tsc` en sous-processus : il
**intègre** le compilateur et lui donne des fichiers virtuels — c'est comme cela
qu'un `<template>` finit typé. Le portage natif de TypeScript 7 n'expose plus
d'API programmatique stable, donc `./lib/tsc` a disparu de ses `exports`. Le
même mur touche `svelte-check`, `astro check` et `typescript-eslint`. Le
déblocage est attendu avec TypeScript 7.1, qui doit restaurer une API publique.

## Ce qui marche

**`typescript@6.0.3` + `vue-tsc@3.3.11`**, et le typage des gabarits est bien là.
Le probe portait volontairement `{{ room.name }}` sur un objet qui n'a que `id` :

```
src/Probe.vue:14:54 - error TS2339: Property 'name' does not exist on type '{ id: string; }'.

14     <li v-for="room in rooms" :key="room.id">{{ room.name }}</li>
                                                        ~~~~
```

L'erreur pointe la **ligne du template**, pas le script. C'est précisément la
classe de défauts que les gabarits littéraux du dépôt ne peuvent pas attraper —
et la raison d'être de la migration.

## La conséquence pour le plan

Les paquets front épinglent `typescript@6.0.3` **localement** et lancent
`vue-tsc` ; tout le reste du dépôt reste sur `typescript@7.0.2` et `tsc`. pnpm
installe les deux sans conflit — ce spike et le reste de l'espace de travail
cohabitent dans la même exécution de `pnpm typecheck`, ce qui est la
démonstration.

Ce n'est pas un contournement à cacher : c'est un état de l'écosystème, daté, à
revoir quand TypeScript 7.1 sort. La convergence sera alors de remonter les
paquets front à 7.x et de supprimer cette note.

## Pourquoi ce spike reste

Il tient dans `pnpm typecheck`. Le jour où une montée de version casse le
typage des gabarits — ou le rétablit sur TypeScript 7 — c'est lui qui le dira,
sans qu'il faille s'en souvenir.
