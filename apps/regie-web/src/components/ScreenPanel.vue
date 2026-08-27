<script setup lang="ts">
import { Panel } from '@cloudnord/components'
import CommandGrid, { type Command } from './CommandGrid.vue'

/**
 * Ce que la salle voit.
 *
 * La boucle en premier : c'est l'écran d'attente par défaut, celui vers lequel
 * on revient. Les pages qu'elle enchaîne restent disponibles seules, pour figer
 * l'écran sur l'une d'elles quand quelque chose se passe.
 */
const MODES: Command[] = [
  { value: 'loop', label: 'Boucle' },
  { value: 'sponsors', label: 'Sponsors' },
  { value: 'programme', label: 'Programme' },
  { value: 'countdown', label: 'Compte à rebours' },
  { value: 'message', label: 'Message' },
  // Fin de talk : le public est encore assis, c'est le seul moment où l'on
  // obtient des retours.
  { value: 'feedback', label: 'Notez le talk' },
  { value: 'wall', label: 'Mur & questions' },
  { value: 'question', label: 'Question choisie' },
]

defineProps<{ mode: string | null }>()
</script>

<template>
  <Panel title="Écran de salle">
    <CommandGrid
      :commands="MODES"
      :current="mode"
      :build="(value) => ({ action: 'display.set', mode: value })"
    />
  </Panel>
</template>
