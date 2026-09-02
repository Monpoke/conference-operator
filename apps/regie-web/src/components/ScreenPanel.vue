<script setup lang="ts">
import { Panel } from '@cloudnord/components'
import { computed } from 'vue'
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

/**
 * Les deux modes qui affichent une chose choisie ailleurs.
 *
 * `message` montre le bandeau saisi dans le panneau Message, `question` la
 * question retenue dans la modération de la régie de salle — ni l'un ni l'autre
 * n'est offert à distance. Les proposer quand même donnerait un bouton qui
 * prend l'écran de la salle pour y projeter « Aucune question affichée » devant
 * le public : le geste réussirait, et c'est bien ce qui le rend mauvais.
 */
const SANS_MATIERE_A_DISTANCE = ['message', 'question']

const props = defineProps<{
  mode: string | null
  /**
   * Servi par le hub, sur un téléphone.
   *
   * Le mode y arrive par le battement de la salle, donc avec un peu de retard
   * sur une bascule décidée sur place. Le bouton n'anticipe pas pour autant —
   * ici comme ailleurs, un bouton allumé décrit ce que la salle montre, pas ce
   * qu'on lui a demandé.
   */
  distant?: boolean
}>()

const commands = computed<Command[]>(() =>
  props.distant === true ? MODES.filter((m) => !SANS_MATIERE_A_DISTANCE.includes(m.value)) : MODES,
)
</script>

<template>
  <Panel title="Écran de salle">
    <CommandGrid
      :commands="commands"
      :current="mode"
      :build="(value) => ({ action: 'display.set', mode: value })"
    />
  </Panel>
</template>
