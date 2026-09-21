<script setup lang="ts">
import type { DisplayPayload } from '@conference-operator/contract'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Button, Key } from '@conference-operator/components'
import { useGatewayStore } from '../stores/gateway.js'
import { useHostStore } from '../stores/host.js'
import CpuIndicator from './CpuIndicator.vue'
import HubIndicator from './HubIndicator.vue'
import ModeBadge from './ModeBadge.vue'
import ProtocolBadge from './ProtocolBadge.vue'
import PortBadge from './PortBadge.vue'
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
const gateway = useGatewayStore()

/**
 * The version, behind a click on the room's name.
 *
 * Asked for when reporting a problem, never during a talk: this line is read at
 * a glance, and a number that never changes would only take room from the ones
 * that do.
 */
const version = computed(() => gateway.boot.version)
const versionShown = ref(false)

/*
 * The queue depth is the indicator to watch during an outage: it is read in the
 * header, and detailed in the hub's tooltip.
 */
const queueDepth = computed(
  () => props.payload.diagnostics?.outboxDepth ?? props.payload.state.outboxDepth ?? 0,
)

/**
 * Full screen, from the page.
 *
 * The browser's own API rather than Electron's: the control app is served over
 * HTTP with no preload, and the same button then works in the room's window, in
 * a browser and on a phone. Hidden where the browser offers none — the iPhone's
 * Safari — rather than shown to do nothing.
 *
 * The state is read back from `fullscreenchange`, never assumed from the click:
 * Escape leaves full screen without going through here.
 */
const fullscreenSupported = typeof document !== 'undefined' && document.fullscreenEnabled === true
const fullscreen = ref(false)

function syncFullscreen(): void {
  fullscreen.value = document.fullscreenElement != null
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement != null) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch {
    // Refused by the browser (no user gesture, a policy): the button stays as it
    // was, which is what the state says.
  }
}

onMounted(() => {
  if (!fullscreenSupported) return
  syncFullscreen()
  document.addEventListener('fullscreenchange', syncFullscreen)
})
onBeforeUnmount(() => document.removeEventListener('fullscreenchange', syncFullscreen))
</script>

<template>
  <header class="flex items-center gap-3 border-b border-edge bg-surface px-3 py-2">
    <div
      class="cursor-default truncate text-[15px] font-semibold select-none"
      data-role="room"
      :title="version == null ? undefined : `Version ${version}`"
      @click="versionShown = !versionShown"
    >
      {{ payload.roomName ?? payload.state.roomId ?? 'Salle non appairée' }}
    </div>
    <span
      v-if="versionShown && version != null"
      class="shrink-0 text-[11px] text-dim"
      data-role="version"
    >
      v{{ version }}
    </span>

    <ModeBadge :mode="payload.diagnostics?.mode ?? null" />
    <ProtocolBadge :protocol="payload.diagnostics?.protocol ?? null" />
    <PortBadge :port="payload.diagnostics?.portFallback ?? null" />

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

    <!-- On the phone too: a page that has the whole screen is read from further away. -->
    <Button
      v-if="fullscreenSupported"
      size="small"
      class="shrink-0"
      data-role="fullscreen"
      :aria-pressed="fullscreen"
      :title="fullscreen ? 'Quitter le plein écran' : 'Plein écran'"
      :aria-label="fullscreen ? 'Quitter le plein écran' : 'Plein écran'"
      @click="toggleFullscreen()"
    >
      {{ fullscreen ? '🗗' : '⛶' }}
    </Button>

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
