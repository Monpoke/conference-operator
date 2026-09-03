<script setup lang="ts">
import { appearanceOf, outlineOf } from '@cloudnord/room-state'
import { computed } from 'vue'
import { DOT_LEVELS, type DotLevel } from './status-levels.js'

/**
 * Two facts in one dot, and they must not be confused.
 *
 * The **fill** says where the conference is. The **outline** says what we know
 * of the room. A dot carrying only connectivity showed a room in green while it
 * was ten minutes over its slot — "green" only ever meant "the machine
 * answers".
 *
 * The vocabulary is not this component's to invent: `appearanceOf` and
 * `outlineOf` produce the class names, and they are shared business code that a
 * page which will never be Vue also reads. This renders them; it does not
 * decide them.
 */
const props = defineProps<{
  /**
   * A conference's state, as the room automaton names it.
   *
   * Mutually exclusive with `level`, and the exclusion is the point: `level`
   * describes a *machine* — the hub answering, a disk filling — where `state`
   * describes what is happening on stage. Offering both would let a caller
   * paint one with the other's meaning, which is the defect the two-part dot
   * exists to prevent.
   */
  state?: string | null
  /** A machine's own health, where there is no conference to describe. */
  level?: DotLevel
  /** What we know of the room, drawn as the outline. */
  connectivity?: string | null
  /** Shows the word beside the dot. Not everyone tells the tints apart. */
  word?: boolean
  class?: string
}>()

const appearance = computed(() => appearanceOf(props.state))

/*
 * L'outline ne s'applique qu'à une salle.
 *
 * `outlineOf` rend « muette » pour une connectivité absente, et c'est juste
 * pour une *salle* — ne rien savoir d'elle et le peindre en plein serait pire
 * que de se taire. Mais un `level` décrit une machine : un processeur, un lien
 * avec le hub. Il n'y a aucune salle derrière, donc rien à mettre en doute, et
 * lui appliquer la règle rendait creuses les deux pastilles de l'en-tête de
 * régie — un anneau vert à la place d'un disque vert.
 */
const classes = computed(() => {
  if (props.level != null) return `status-dot ${DOT_LEVELS[props.level]}`.trim()
  return `status-dot ${appearance.value.tint}${outlineOf(props.connectivity)}`.trim()
})
</script>

<template>
  <span v-if="word !== true" :class="[classes, props.class]"></span>
  <span v-else class="inline-flex items-center gap-1.5">
    <span :class="[classes, props.class]"></span>
    <span :class="appearance.text">{{ appearance.word }}</span>
  </span>
</template>
