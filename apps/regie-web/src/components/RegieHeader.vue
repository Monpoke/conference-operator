<script setup lang="ts">
import type { DisplayPayload } from '@cloudnord/contract'
import { computed } from 'vue'
import { useHostStore } from '../stores/host.js'
import CpuIndicator from './CpuIndicator.vue'
import HubIndicator from './HubIndicator.vue'
import ModeBadge from './ModeBadge.vue'
import RoomClock from './RoomClock.vue'

const props = defineProps<{
  payload: DisplayPayload
  /** Heure de la salle, décalage du hub compris. */
  nowMs: number
  /** Le flux de la page est coupé depuis assez longtemps pour le dire. */
  streamDead: boolean
}>()

const host = useHostStore()

/*
 * La profondeur de file est l'indicateur à surveiller pendant une coupure :
 * elle se lit dans le bandeau, et se détaille dans l'info-bulle du hub.
 */
const queueDepth = computed(
  () => props.payload.diagnostics?.outboxDepth ?? props.payload.state.outboxDepth ?? 0,
)
</script>

<template>
  <header class="flex items-center gap-3 border-b border-bord bg-surface px-3 py-2">
    <div class="truncate text-[15px] font-semibold" data-role="room">
      {{ payload.roomName ?? payload.state.roomId ?? 'Salle non appairée' }}
    </div>

    <ModeBadge :mode="payload.diagnostics?.mode ?? null" />

    <HubIndicator
      :connectivity="payload.state.connectivity"
      :queue-depth="queueDepth"
      :offset-ms="payload.state.serverTimeOffsetMs"
      :simulated-clock="payload.state.simulatedClock"
    />

    <CpuIndicator :load="host.load" />

    <div v-if="queueDepth > 0" class="shrink-0 text-xs text-attention" data-role="queue">
      {{ queueDepth }} en attente
    </div>

    <!--
      Le flux de la page est mort : ce qui est affiché ne bouge plus.

      Sans ce mot, une page figée passe pour une page vivante — l'horloge, le
      compte à rebours et le flux des salles se redessinent chaque seconde
      depuis la dernière charge utile reçue, et continuent donc d'avancer. Seul
      l'état de la conférence reste bloqué, sur ce qu'il disait à la coupure.
      C'est exactement ce qu'on ne peut pas diagnostiquer depuis une salle.
    -->
    <div
      v-if="streamDead"
      class="shrink-0 text-xs font-semibold text-alerte"
      role="alert"
      data-role="stream-dead"
    >
      écran figé — flux interrompu
    </div>

    <RoomClock
      :at-ms="nowMs"
      :time-zone="payload.timezone"
      :simulated="payload.state.simulatedClock"
    />
  </header>
</template>
