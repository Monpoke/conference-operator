<script setup lang="ts">
import type { DisplayPayload } from '@cloudnord/contract'
import { stopwatch } from '@cloudnord/format'
import { computed } from 'vue'
import { countdownFor } from '../lib/countdown.js'

/** Below this threshold, the end becomes something to watch rather than to know. */
const NEARLY_OVER_MS = 300_000

const props = defineProps<{ payload: DisplayPayload; atMs: number }>()

const countdown = computed(() => countdownFor(props.payload, props.atMs))

/*
 * Before the start, the countdown demands nothing: dimmed, it is told apart from
 * a running slot — which turns to warning and then to alert.
 */
const tint = computed(() => {
  const count = countdown.value
  if (count == null || count.beforeStart) return 'text-dim'
  if (count.ms < 0) return 'text-alert'
  return count.ms < NEARLY_OVER_MS ? 'text-warn' : 'text-text'
})
</script>

<template>
  <div class="flex items-baseline gap-2">
    <div class="text-[40px] leading-none font-bold tabular-nums" :class="tint" data-role="countdown">
      {{ countdown == null ? '--:--' : stopwatch(countdown.ms) }}
    </div>
    <!--
      The badge says what the number is counting down: air time running out, or a
      wait before things start again. The two read alike without it.
    -->
    <span v-if="countdown?.beforeStart === true" class="badge">à venir</span>
  </div>
</template>
