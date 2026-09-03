<script setup lang="ts">
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './cn.js'

/**
 * A command, sized for a dark room during a talk.
 *
 * Written here rather than copied from shadcn-vue, and the reason is the
 * padding: `py-3.5` is fourteen vertical pixels, chosen on purpose ("wide
 * targets"), where shadcn's button is `h-9 px-4 py-2` — a density meant for a
 * desktop application somebody is leaning into. The shortcut badge has no slot
 * in shadcn's shape either, and eighteen commands carry one.
 */
const button = cva(
  'cursor-pointer rounded-lg border text-sm font-semibold transition-colors ' +
    'disabled:cursor-not-allowed disabled:opacity-40',
  {
    variants: {
      variant: {
        neutral: 'border-edge bg-surface2 text-text hover:not-disabled:border-brand hover:not-disabled:bg-edge',
        primary: 'border-brand bg-brand text-[#05070d]',
        danger: 'border-[#6c2027] bg-[#3a1519] text-text hover:not-disabled:border-brand',
        tab: 'border-transparent bg-transparent text-dim hover:not-disabled:border-edge',
      },
      size: {
        normal: 'px-2.5 py-3.5',
        small: 'px-3 py-2 text-[13px]',
      },
      /**
       * Pressed, as in "this is the mode the room is in".
       *
       * A separate variant rather than a colour, because it means the same
       * thing on every family: the button is not offering an action, it is
       * reporting a state.
       */
      active: { true: '', false: '' },
    },
    compoundVariants: [
      { variant: 'neutral', active: true, class: 'border-brand bg-brand text-[#05070d]' },
      { variant: 'danger', active: true, class: 'border-alert bg-alert text-white' },
      { variant: 'tab', active: true, class: 'border-edge bg-surface2 text-text' },
    ],
    defaultVariants: { variant: 'neutral', size: 'normal', active: false },
  },
)

type ButtonVariants = VariantProps<typeof button>

const props = withDefaults(
  defineProps<{
    variant?: ButtonVariants['variant']
    size?: ButtonVariants['size']
    active?: boolean
    type?: 'button' | 'submit'
    disabled?: boolean
    class?: string
  }>(),
  { type: 'button' },
)
</script>

<template>
  <button
    :type="props.type"
    :disabled="props.disabled"
    :class="cn(button({ variant: props.variant, size: props.size, active: props.active }), props.class)"
  >
    <slot />
  </button>
</template>
