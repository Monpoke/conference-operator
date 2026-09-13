<script setup lang="ts">
import { appearanceOf } from '@conference-operator/room-state'
import { Badge, Empty, Panel, StatusDot } from '@conference-operator/components'
import { time, timeAgo } from '@conference-operator/format'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useConferencesStore } from '../stores/conferences.js'
import { slotRemaining, useOperationsStore, type RoomStatus } from '../stores/operations.js'

/**
 * The dashboard.
 *
 * This is the view left open all day, and the one looked at from afar: hence cards
 * rather than a table, a word beside every colour, and nothing that requires
 * reading to understand that a room is in trouble.
 */
const store = useOperationsStore()
const { rooms, globalBreak } = storeToRefs(store)

/**
 * The event's time zone, when it is known.
 *
 * It comes from the schedule, which this view does not load — it only needs it for
 * two times in the Global panel. Without it the machine's own time zone serves,
 * which reproduces exactly what the page used to do. A room is not affected: the
 * cards carry no absolute time, only durations.
 */
const zone = computed(() => useConferencesStore().planning?.timezone)

function appearance(room: RoomStatus): { word: string; text: string } {
  const { word, text } = appearanceOf(room.conference)
  return { word, text }
}

/**
 * A shared slot does not present itself as a talk.
 *
 * During lunch the card announced "Déjeuner · 22 min restantes" exactly as it
 * announces a talk: same place, same shape, same countdown. One read a busy room
 * where there is nobody. A tag beside the name, and the line below stays silent —
 * the slot's detail lives in the Global panel, where it is said once and for all.
 */
function onBreak(room: RoomStatus): boolean {
  return room.breakBadge?.state === 'en-cours'
}

/**
 * What goes wrong with OBS, in words — and only on a room that answers.
 *
 * A silent room says nothing about its OBS: what it reported last is exactly
 * what can no longer be trusted, and "salle muette" already says so.
 */
function obsIssues(room: RoomStatus): { text: string; variant: 'alert' | 'warning' }[] {
  if (room.connectivity !== 'ONLINE' || room.obs == null) return []
  const issues: { text: string; variant: 'alert' | 'warning' }[] = []
  for (const instance of ['A', 'B'] as const) {
    const link = room.obs[instance]
    if (link.connected === false) issues.push({ text: `OBS-${instance} coupé`, variant: 'alert' })
    else if (link.missingRoles.length > 0) {
      const roles = link.missingRoles.join(', ')
      issues.push({
        text: link.missingRoles.length === 1 ? `scène ${roles} introuvable` : `scènes ${roles} introuvables`,
        variant: 'warning',
      })
    }
  }
  return issues
}

/** Congestion or skipped frames past these, the stream is visibly suffering. */
const CONGESTION_ALERT = 0.2
const SKIPPED_ALERT = 0.01

/** The stream's health while it runs: the bitrate, and why it worries if it does. */
function streamHealth(room: RoomStatus): { text: string; variant: 'neutral' | 'warning' } | null {
  const health = room.streamHealth
  if (!room.streaming || room.connectivity !== 'ONLINE' || health == null) return null
  const rate = health.bitrateKbps >= 1000
    ? `${(health.bitrateKbps / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mb/s`
    : `${Math.round(health.bitrateKbps)} kb/s`
  const worries: string[] = []
  if (health.congestion >= CONGESTION_ALERT) worries.push(`congestion ${Math.round(health.congestion * 100)} %`)
  if (health.skippedRatio >= SKIPPED_ALERT) worries.push(`${Math.round(health.skippedRatio * 100)} % d'images perdues`)
  return worries.length === 0
    ? { text: rate, variant: 'neutral' }
    : { text: [rate, ...worries].join(' · '), variant: 'warning' }
}

function remaining(room: RoomStatus): ReturnType<typeof slotRemaining> {
  return onBreak(room) ? null : slotRemaining(room.currentSession?.remainingMs)
}

/** What one comes to the panel for: when it resumes, or when it starts. */
const globalDetail = computed(() => {
  const slot = globalBreak.value
  if (slot == null) return ''
  const roomCount = `${slot.rooms} ${slot.rooms > 1 ? 'salles' : 'salle'}`
  const running = slot.state === 'en-cours'
  const edge = running ? slot.endsAt : slot.startsAt
  if (edge == null) return roomCount
  const minutes = Math.round((Date.parse(edge) - Date.parse(slot.serverTime)) / 60000)
  return `${running ? 'reprise dans ' : 'dans '}${minutes} min · ${roomCount}`
})
</script>

<template>
  <div
    id="operations-view"
    class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-start gap-3.5"
  >
    <Panel v-if="globalBreak != null" id="global-panel" class="col-span-full" title="Global">
      <div class="flex items-center gap-2">
        <!--
          The shared slot is not a talk: its tint is set by hand, and does not come
          from the appearance table — `APPEARANCE.pause` describes a *room* on a
          break, not the slot itself.
        -->
        <span
          id="global-status-dot"
          class="status-dot"
          :class="globalBreak.state === 'en-cours' ? 'break' : 'not-started'"
        ></span>
        <span id="global-title" class="flex-1 truncate font-semibold">
          {{ globalBreak.title }}{{ globalBreak.state === 'en-cours' ? '' : ' — à venir' }}
        </span>
        <span id="global-hours" class="shrink-0 text-[13px] text-dim tabular-nums">
          {{ time(globalBreak.startsAt, zone)
          }}{{ globalBreak.endsAt ? ` – ${time(globalBreak.endsAt, zone)}` : '' }}
        </span>
      </div>
      <div id="global-detail" class="mt-1 text-xs text-dim">{{ globalDetail }}</div>
    </Panel>

    <Panel class="col-span-full" title="Salles">
      <div
        id="rooms"
        class="grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-2.5"
      >
        <Empty v-if="rooms.length === 0">Aucune salle déclarée.</Empty>

        <div
          v-for="room in rooms"
          :key="room.roomId"
          class="rounded-xl border border-edge bg-canvas p-3"
          :data-room="room.roomId"
        >
          <div class="flex items-center gap-2">
            <StatusDot :state="room.conference" :connectivity="room.connectivity" />
            <span class="min-w-0 flex-1 truncate font-semibold">{{ room.name }}</span>
            <Badge
              v-if="room.breakBadge != null"
              class="px-1.5 py-0.5 text-[11px] tracking-normal"
              :variant="onBreak(room) ? 'neutral' : 'warning'"
            >
              {{ onBreak(room) ? 'BREAK' : 'BREAK à venir' }}
            </Badge>
            <a
              class="shrink-0 text-[13px] text-brand no-underline"
              target="_blank"
              rel="noopener"
              :href="`/mur?salle=${encodeURIComponent(room.roomId)}`"
            >
              mur ↗
            </a>
          </div>

          <!-- What is playing: the first thing one comes to check. -->
          <div class="mt-1.5 text-[13px] leading-snug">
            <span v-if="onBreak(room)" class="text-dim">—</span>
            <template v-else-if="room.currentSession != null">
              {{ room.currentSession.title }}
            </template>
            <span v-else class="text-dim">Rien au programme</span>
          </div>

          <!--
            And for how much longer: without it, knowing what is playing does not
            say whether the room is early, on time, or overrunning.
          -->
          <div
            v-if="remaining(room) != null"
            class="mt-0.5 text-xs"
            :class="remaining(room)!.overrun ? 'text-alert' : 'text-dim'"
          >
            {{ remaining(room)!.text }}
          </div>

          <div
            v-if="room.recording || room.streaming || room.sceneRole != null || room.outboxDepth > 0 || obsIssues(room).length > 0"
            class="mt-2 flex flex-wrap gap-1.5"
          >
            <Badge v-if="room.recording" class="px-1.5 py-0.5 text-[11px] tracking-normal" variant="alert">
              ● REC
            </Badge>
            <Badge v-if="room.streaming" class="px-1.5 py-0.5 text-[11px] tracking-normal text-ok">
              ● LIVE
            </Badge>
            <Badge v-if="room.sceneRole != null" class="px-1.5 py-0.5 text-[11px] tracking-normal">
              {{ room.sceneRole }}
            </Badge>
            <Badge
              v-for="issue in obsIssues(room)"
              :key="issue.text"
              class="px-1.5 py-0.5 text-[11px] tracking-normal"
              :variant="issue.variant"
            >
              {{ issue.text }}
            </Badge>
            <Badge
              v-if="streamHealth(room) != null"
              class="px-1.5 py-0.5 text-[11px] tracking-normal normal-case"
              :variant="streamHealth(room)!.variant"
            >
              {{ streamHealth(room)!.text }}
            </Badge>
            <Badge
              v-if="room.outboxDepth > 0"
              class="px-1.5 py-0.5 text-[11px] tracking-normal"
              variant="warning"
            >
              {{ room.outboxDepth }} en file
            </Badge>
          </div>

          <!--
            The word accompanies the colour: a dot on its own cannot be read by
            somebody who does not tell the tints apart, and the card is looked at
            from afar.
          -->
          <div class="mt-2 text-xs text-dim">
            <span :class="appearance(room).text">
              {{ room.connectivity === 'ONLINE' ? appearance(room).word : 'salle muette' }}
            </span>
            · {{ room.connectivity.toLowerCase() }} · vu {{ timeAgo(room.lastSeenAt) }}
          </div>
        </div>
      </div>
    </Panel>
  </div>
</template>
