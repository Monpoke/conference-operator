<script setup lang="ts">
import { computed, ref } from 'vue'

/**
 * Ce que ce spike prouve, et pourquoi il reste dans le dépôt.
 *
 * `vue-tsc` type le contenu du `<template>`, pas seulement celui du `<script>` :
 * c'est le bénéfice qui justifie la migration, et il ne va pas de soi puisque
 * le dépôt est épinglé sur TypeScript 7, sur lequel `vue-tsc` ne démarre même
 * pas. Voir FINDINGS.md.
 *
 * Ce fichier compile. Écrire `room.libelle` dans le gabarit ci-dessous doit
 * produire une erreur de compilation pointant la ligne du template — c'est la
 * vérification qui a été faite, et que `pnpm typecheck` rejoue à chaque
 * exécution.
 */
interface Room {
  id: string
  name: string
}

const count = ref(0)
const label = computed(() => `${count.value} salle(s)`)
const rooms: Room[] = [{ id: 'track-1', name: 'Track #1' }]
</script>

<template>
  <p>{{ label }}</p>
  <ul>
    <li v-for="room in rooms" :key="room.id">{{ room.name }}</li>
  </ul>
</template>
