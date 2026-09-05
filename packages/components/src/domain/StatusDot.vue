<script setup lang="ts">
import { appearanceOf, outlineOf } from '@conference-operator/room-state'
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
 * The outline only applies to a room.
 *
 * `outlineOf` returns `silent` for a missing connectivity, and that is right for
 * a *room* — knowing nothing about it and painting it solid would be worse than
 * saying nothing. But a `level` describes a machine: a CPU, a link to the hub.
 * There is no room behind it, so nothing to doubt, and applying the rule turned
 * both dots in the control header hollow — a green ring where a green disc
 * belongs.
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
