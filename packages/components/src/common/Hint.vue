<script setup lang="ts">
import { cn } from './cn.js'

/** Secondary text under a control: what it does, or what it will cost. */
const props = defineProps<{
  /**
   * Merged, not appended: a caller's `text-alert` or `mt-0` must win over the
   * defaults. Left to Vue's fallthrough, both classes landed on the element and
   * the stylesheet's order decided — an error read in grey.
   */
  class?: string
}>()
</script>

<template>
  <p :class="cn('mt-2.5 text-[13px] leading-relaxed text-dim', props.class)"><slot /></p>
</template>
