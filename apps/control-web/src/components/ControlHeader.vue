<script setup lang="ts">
import type { DisplayPayload } from '@conference-operator/contract'
import { computed } from 'vue'
import { Button, Key } from '@conference-operator/components'
import { useHostStore } from '../stores/host.js'
import CpuIndicator from './CpuIndicator.vue'
import HubIndicator from './HubIndicator.vue'
import ModeBadge from './ModeBadge.vue'
import RoomClock from './RoomClock.vue'
import ScreensMenu from './ScreensMenu.vue'

const props = defineProps<{
  payload: DisplayPayload
  /** The room's time, the hub's offset included. */
  nowMs: number
  /** The page's stream has been cut long enough to be worth saying. */
  streamDead: boolean
  /**
   * Served by the hub, on a phone.
   *
   * What falls away then: the buttons that open machine modals (program, rooms, ⚙,
   * screens) and the host load, served by the room machine. What is left is
   * everything that says **where the room stands** — the only reason to look at
   * this line.
   */
  remote?: boolean
}>()

const emit = defineEmits<{ open: [tab: 'program' | 'rooms']; config: [] }>()

const host = useHostStore()

/*
 * The queue depth is the indicator to watch during an outage: it is read in the
 * header, and detailed in the hub's tooltip.
 */
const queueDepth = computed(
  () => props.payload.diagnostics?.outboxDepth ?? props.payload.state.outboxDepth ?? 0,
)
</script>

<template>
  <header class="flex items-center gap-3 border-b border-edge bg-surface px-3 py-2">
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

    <CpuIndicator v-if="remote !== true" :load="host.load" />

    <!--
      Remote driving, seen from the room.

      It greys nothing out: the operator who is there keeps every one of their
      commands, whatever happens to a phone gone off down a corridor. It is here
      because this is the line one reads to know what state the room is in — and
      because a scene switching with nobody having touched the keyboard otherwise
      reads as a failure, in the middle of a talk.
    -->
    <div
      v-if="payload.state.remoteHolder != null && remote !== true"
      class="shrink-0 truncate text-xs text-warn"
      data-role="remote-holder"
      :title="`${payload.state.remoteHolder} pilote cette salle depuis la régie mobile. Vos commandes restent actives.`"
    >
      pilotée à distance — {{ payload.state.remoteHolder }}
    </div>

    <div v-if="queueDepth > 0" class="shrink-0 text-xs text-warn" data-role="queue">
      {{ queueDepth }} en attente
    </div>

    <!--
      The page's stream is dead: what is displayed no longer moves.

      Without this word, a frozen page passes for a live one — the clock, the
      countdown and the rooms strip redraw every second from the last payload
      received, and therefore keep advancing. Only the talk's state stays stuck, on
      what it said at the cut. That is exactly what cannot be diagnosed from a
      room.
    -->
    <div
      v-if="streamDead"
      class="shrink-0 text-xs font-semibold text-alert"
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

    <div v-if="remote !== true" class="flex shrink-0 items-center gap-1.5">
      <Button id="btn-program" size="small" @click="emit('open', 'program')">
        Programme<Key>P</Key>
      </Button>
      <Button id="btn-rooms" size="small" @click="emit('open', 'rooms')">
        Salles<Key>S</Key>
      </Button>
      <Button
        id="btn-config"
        size="small"
        title="Configuration de la salle"
        @click="emit('config')"
      >
        ⚙
      </Button>
      <ScreensMenu :payload="payload" />
    </div>
  </header>
</template>
