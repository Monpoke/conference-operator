<script setup lang="ts">
import type { AudioAlert } from '@conference-operator/contract'
import { computed } from 'vue'

/**
 * What the capture watchdog hears wrong, while the talk is recorded.
 *
 * Not a notification: those go after thirty seconds, and a dead microphone does
 * not. The strip stays across the top of the control app — the dock's too, it
 * is what the operator watches in OBS — as long as the room hears the problem,
 * and goes by itself when it is fixed. Red, solid: the VOD is being lost.
 */
const props = defineProps<{ alerts: AudioAlert[]; nowMs: number }>()

const WHAT: Record<AudioAlert['kind'], string> = {
  muet: 'coupé dans OBS-B',
  silence: 'silencieux — batterie, câble, récepteur ?',
  saturation: 'saturé — baisser le gain',
}

const lines = computed(() =>
  props.alerts.map((alert) => {
    const minutes = Math.floor((props.nowMs - Date.parse(alert.since)) / 60_000)
    return {
      key: `${alert.kind}:${alert.input}`,
      text: `Micro « ${alert.input} » ${WHAT[alert.kind]}`,
      since: minutes < 1 ? 'à l’instant' : `depuis ${minutes} min`,
    }
  }),
)
</script>

<template>
  <div v-if="lines.length > 0" class="flex flex-col gap-1 bg-alert px-3 py-1.5 text-[13px] font-semibold text-[#05070d]" role="alert" data-role="audio-alerts">
    <p v-for="line in lines" :key="line.key" class="flex items-baseline gap-2" :data-audio-alert="line.key">
      <span aria-hidden="true">●</span>
      <span class="min-w-0 flex-1">{{ line.text }}</span>
      <span class="text-xs font-medium opacity-70">enregistrement en cours · {{ line.since }}</span>
    </p>
  </div>
</template>
