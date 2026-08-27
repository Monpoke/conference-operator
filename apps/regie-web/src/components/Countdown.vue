<script setup lang="ts">
import type { DisplayPayload } from '@cloudnord/contract'
import { stopwatch } from '@cloudnord/format'
import { computed } from 'vue'
import { countdownFor } from '../lib/countdown.js'

/** Sous ce seuil, la fin devient une chose à surveiller plutôt qu'à savoir. */
const NEARLY_OVER_MS = 300_000

const props = defineProps<{ payload: DisplayPayload; atMs: number }>()

const countdown = computed(() => countdownFor(props.payload, props.atMs))

/*
 * Avant le début, le décompte ne réclame rien : atténué, il se distingue d'un
 * créneau qui court — lequel vire à l'attention puis à l'alerte.
 */
const tint = computed(() => {
  const count = countdown.value
  if (count == null || count.beforeStart) return 'text-attenue'
  if (count.ms < 0) return 'text-alerte'
  return count.ms < NEARLY_OVER_MS ? 'text-attention' : 'text-texte'
})
</script>

<template>
  <div class="flex items-baseline gap-2">
    <div class="text-[40px] leading-none font-bold tabular-nums" :class="tint" data-role="countdown">
      {{ countdown == null ? '--:--' : stopwatch(countdown.ms) }}
    </div>
    <!--
      Le badge dit ce que le nombre décompte : un temps d'antenne qui s'épuise,
      ou une attente avant que ça reparte. Les deux se lisent pareil sans lui.
    -->
    <span v-if="countdown?.beforeStart === true" class="badge">à venir</span>
  </div>
</template>
