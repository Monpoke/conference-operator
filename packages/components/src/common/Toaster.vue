<script setup lang="ts">
import { useToast } from './toast.js'

/**
 * Where the notices land.
 *
 * `role="status"` and `aria-live="polite"` are new: none of the three
 * implementations this replaces announced anything, so an operator using a
 * screen reader was told a command had failed by nothing at all.
 *
 * "polite" rather than "assertive" even for failures — the console is not the
 * surface that stops a talk, and interrupting whatever is being read to say a
 * request went wrong would cost more than it tells.
 */
const { notices, dismiss } = useToast()
</script>

<template>
  <div
    class="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2"
    role="status"
    aria-live="polite"
  >
    <!--
      The whole card is the button, as in the notice stack it shares the bottom
      of the screen with, and for the same reason: a notice is read at a glance
      and swept aside with a flick of the mouse, while holding the microphone.
      A `<button>` rather than a `<div>` listening for the click — it takes
      keyboard focus, announces itself as actionable, and answers Enter.
    -->
    <button
      v-for="notice in notices"
      :key="notice.id"
      type="button"
      class="pointer-events-auto max-w-[min(560px,90vw)] cursor-pointer rounded-[10px] border-0 px-4 py-3 text-left text-sm shadow-lg"
      :class="notice.failed ? 'bg-[#35161a] text-alert' : 'bg-[#102e22] text-ok'"
      :data-notice="notice.id"
      :title="`Écarter : ${notice.text}`"
      @click="dismiss(notice.id)"
    >
      {{ notice.text }}
    </button>
  </div>
</template>
