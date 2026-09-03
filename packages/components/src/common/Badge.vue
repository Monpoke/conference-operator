<script setup lang="ts">
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './cn.js'

/**
 * A state label — running, ended, simulated, on a break.
 *
 * This replaces five separate factories that had grown apart across the two
 * consoles. `text-sm` and **not** `text-xs`, which is the one decision worth
 * repeating: in the conferences table, against 13 px of base text, a 12 px
 * label in tightened capitals read like a footnote — when it is the talk's
 * state people come to that column to find. It has to be spotted without being
 * read, which is also why the word is there at all: not everyone tells the
 * tints apart.
 */
const badge = cva(
  'inline-block rounded-md px-3 py-1 text-sm font-bold tracking-[.06em] whitespace-nowrap uppercase',
  {
    variants: {
      variant: {
        neutral: 'bg-surface2 text-dim',
        running: 'bg-ok text-[#05231a]',
        ended: 'bg-[#3a2a13] text-warn',
        warning: 'bg-surface2 text-warn',
        alert: 'bg-surface2 text-alert',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
)

const props = defineProps<{
  variant?: VariantProps<typeof badge>['variant']
  class?: string
}>()
</script>

<template>
  <span :class="cn(badge({ variant: props.variant }), props.class)"><slot /></span>
</template>
