<script setup lang="ts">
import { appearanceOf } from '@conference-operator/room-state'
import { Badge, Button, ConfirmDialog, Empty, Panel, StatusDot, useToast } from '@conference-operator/components'
import { time, timeAgo } from '@conference-operator/format'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { useConferencesStore } from '../stores/conferences.js'
import { useFeaturesStore } from '../stores/features.js'
import { slotRemaining, useOperationsStore, type RoomStatus } from '../stores/operations.js'
import { useSessionStore } from '../stores/session.js'

/**
 * The dashboard.
 *
 * This is the view left open all day, and the one looked at from afar: hence cards
 * rather than a table, a word beside every colour, and nothing that requires
 * reading to understand that a room is in trouble.
 */
const store = useOperationsStore()
// The "mur ↗" link goes when the hub closed both the wall and the questions.
const features = useFeaturesStore()
void features.load()
const { rooms, globalBreak, incidents } = storeToRefs(store)

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

/**
 * The capture watchdog's alerts, as the room reported them: a microphone muted,
 * silent or clipping while a talk is recorded. Red: the VOD is being lost. Only
 * for a room that answers — what a silent room last said is no longer true.
 */
const AUDIO_ALERT_WORD = { muet: 'coupé', silence: 'silencieux', saturation: 'saturé' } as const
function audioIssues(room: RoomStatus): string[] {
  if (room.connectivity !== 'ONLINE') return []
  return (room.audioAlerts ?? []).map((alert) => `Micro « ${alert.input} » ${AUDIO_ALERT_WORD[alert.kind]}`)
}

/**
 * The worst that is true of a room, and what the dot and the card's tint show.
 *
 * The talk's state stays in words: a room overrunning with a working capture does
 * not call for the same gesture as a green dot losing its VOD. `muette` comes
 * first because it voids the rest: nothing else can be known about that room.
 * DEGRADED is not silence: real time failed, but the room still answers over HTTP.
 */
type RoomHealth = 'muette' | 'panne' | 'attention' | 'normal'
function health(room: RoomStatus): RoomHealth {
  if (room.connectivity !== 'ONLINE' && room.connectivity !== 'DEGRADED') return 'muette'
  const obs = obsIssues(room)
  if (obs.some((issue) => issue.variant === 'alert') || audioIssues(room).length > 0) return 'panne'
  if (room.connectivity === 'DEGRADED' || obs.length > 0 || streamHealth(room)?.variant === 'warning') return 'attention'
  return 'normal'
}

const HEALTH_DOT = { panne: 'alert', attention: 'warn', normal: 'ok' } as const
const HEALTH_CARD: Record<RoomHealth, string> = {
  muette: 'border-alert bg-alert-soft',
  panne: 'border-alert bg-alert-soft',
  attention: 'border-warn/50 bg-warn-soft',
  normal: 'border-edge bg-canvas',
}
const HEALTH_WORD: Record<RoomHealth, string> = {
  muette: 'Salle muette',
  panne: 'En panne',
  attention: 'À surveiller',
  normal: 'Tout va bien',
}

/** What is wrong, worst first: the first one heads the card, the rest follow it. */
function problems(room: RoomStatus): string[] {
  const obs = obsIssues(room)
  return [
    ...obs.filter((issue) => issue.variant === 'alert').map((issue) => issue.text),
    ...audioIssues(room),
    ...obs.filter((issue) => issue.variant === 'warning').map((issue) => issue.text),
    ...(room.connectivity === 'DEGRADED' ? ['Liaison dégradée'] : []),
    ...(streamHealth(room)?.variant === 'warning' ? ['Flux en difficulté'] : []),
  ]
}

/**
 * A talk under way with nothing being recorded. Said, but not a failure: nothing
 * tells the console that this room was meant to record, and a workshop may not be.
 */
const TALK_UNDER_WAY = ['en-cours', 'fin-proche', 'depassement']
function recordingMissing(room: RoomStatus): boolean {
  return room.connectivity === 'ONLINE' && !room.recording && !onBreak(room) && TALK_UNDER_WAY.includes(room.conference)
}

/**
 * What a silent room said before going quiet: worth knowing, but no longer a
 * fact. The time left stays out of this: the hub computes it from the programme.
 */
function lastContact(room: RoomStatus): string {
  return [
    room.recording ? 'REC' : null,
    room.streaming ? 'LIVE' : null,
    room.sceneRole,
    room.outboxDepth > 0 ? `${room.outboxDepth} en file` : null,
  ]
    .filter((fact) => fact != null)
    .join(' · ')
}

/**
 * Under 4.5:1 in the light theme, the brand cannot carry small link text on a
 * card, tinted or not: the underline says "link", the text stays neutral. And a
 * focus ring of its own, since the cards are also reached by keyboard.
 */
const LINK = 'rounded-sm py-1 text-text underline decoration-dim underline-offset-2 pointer-coarse:py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand'

/** The footer's quiet facts. The talk's word only when a problem took the state line. */
function footer(room: RoomStatus): string {
  return [
    problems(room).length > 0 ? appearance(room).word : null,
    room.connectivity === 'ONLINE' ? 'en ligne' : null,
    `vu ${timeAgo(room.lastSeenAt)}`,
  ]
    .filter((part) => part != null)
    .join(' · ')
}
function missingTone(room: RoomStatus): string {
  return health(room) === 'normal' ? 'font-semibold text-warn' : 'font-semibold text-text'
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

// A troubleshooting gesture, shown only to whoever the hub would let do it.
const session = useSessionStore()
const toast = useToast()
const resyncRoom = ref('')
const resyncConfirmation = ref(false)
const resyncRoomName = computed(
  () => rooms.value.find((room) => room.roomId === resyncRoom.value)?.name ?? null,
)

async function confirmResync(): Promise<void> {
  try {
    const result = await store.resync(resyncRoom.value === '' ? null : resyncRoom.value)
    /*
     * The number of rooms targeted, not a "it's off". A hub with no paired room at
     * all accepts the request with nothing leaving: saying "requested" would then be
     * exact and misleading.
     */
    toast.say(
      resyncRoomName.value != null
        ? `Resynchronisation demandée à ${resyncRoomName.value}`
        : result.rooms === 0
          ? "Aucune salle sur ce hub : la demande n'atteindra personne"
          : `Resynchronisation demandée à ${result.rooms} salle(s)`,
    )
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <div
    id="operations-view"
    class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] gap-3.5"
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

    <Panel class="col-span-full">
      <div class="mb-2.5 flex flex-wrap items-center gap-2">
        <h2 class="mb-0 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">Salles</h2>
        <Button
          v-if="session.can('room:manage')"
          id="btn-resync"
          size="small"
          class="ml-auto"
          @click="resyncConfirmation = true"
        >
          Resynchroniser…
        </Button>
      </div>
      <div
        id="rooms"
        class="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-2.5"
      >
        <Empty v-if="rooms.length === 0">Aucune salle déclarée.</Empty>

        <div
          v-for="room in rooms"
          :key="room.roomId"
          class="flex min-w-0 flex-col rounded-xl border p-4 [overflow-wrap:anywhere]"
          :class="HEALTH_CARD[health(room)]"
          :data-room="room.roomId"
          :data-health="health(room)"
        >
          <div class="flex items-center gap-2.5">
            <!-- Hollow when silent: the shared vocabulary for "we no longer know". -->
            <StatusDot
              v-if="health(room) === 'muette'"
              class="size-3.5"
              :state="room.conference"
              :connectivity="room.connectivity"
            />
            <StatusDot v-else class="size-3.5" :level="HEALTH_DOT[health(room) as keyof typeof HEALTH_DOT]" />
            <!-- Two lines rather than an ellipsis: "Amphi… Track 1" and "Amphi… Track 2" read the same. -->
            <h3 class="mb-0 line-clamp-2 min-w-0 flex-1 text-xl leading-tight font-semibold" :title="room.name">
              {{ room.name }}<span class="sr-only"> : {{ HEALTH_WORD[health(room)] }}</span>
            </h3>
            <Badge
              v-if="room.breakBadge != null"
              class="shrink-0 px-1.5 py-0.5 text-[11px] tracking-normal"
              :variant="onBreak(room) ? 'neutral' : 'warning'"
            >
              {{ onBreak(room) ? 'BREAK' : 'BREAK à venir' }}
            </Badge>
          </div>

          <!--
            The one answer readable from afar: the worst of what is wrong or, when
            nothing is, what the talk is doing. Kept mounted: a live region that
            appears with its text is not always announced. 19 px bold is large text
            for WCAG, which is what lets the state colours stay readable in light.
          -->
          <div class="mt-2 text-[1.1875rem] leading-snug font-bold" aria-live="polite">
            <p v-if="health(room) === 'muette'" class="mb-0 text-text first-letter:uppercase" data-role="silent-room">
              salle muette<span aria-hidden="true" class="block text-sm font-normal tabular-nums first-letter:uppercase">
                {{ room.lastSeenAt == null ? 'jamais vue' : `vue il y a ${timeAgo(room.lastSeenAt)}` }}</span>
            </p>
            <p v-else-if="problems(room).length > 0" class="mb-0 text-text" data-role="problem">{{ problems(room)[0] }}</p>
            <p v-else class="mb-0 first-letter:uppercase" :class="appearance(room).text" data-role="talk-state">
              {{ appearance(room).word }}
            </p>
          </div>
          <ul v-if="problems(room).length > 1" class="mt-0.5 mb-0 list-none p-0 text-sm font-semibold">
            <li v-for="problem in problems(room).slice(1)" :key="problem" data-role="problem">{{ problem }}</li>
          </ul>

          <!-- What is playing, and for how much longer: what one comes to check next. -->
          <div v-if="!onBreak(room)" class="mt-3 text-sm leading-snug">
            <span v-if="room.currentSession != null" class="line-clamp-2" :title="room.currentSession.title">{{ room.currentSession.title }}</span>
            <span v-else class="text-dim">Rien au programme</span>
          </div>
          <div
            v-if="remaining(room) != null"
            class="mt-0.5 text-lg leading-tight font-semibold text-text tabular-nums"
          >
            {{ remaining(room)!.text }}
          </div>

          <!-- Telemetry: useful once one is looking at the card, silent from afar. -->
          <div
            v-if="health(room) === 'muette' && lastContact(room) !== ''"
            class="mt-3 text-xs text-text"
            data-role="last-contact"
          >
            Au dernier contact : {{ lastContact(room) }}
          </div>
          <div
            v-else-if="health(room) !== 'muette'"
            class="mt-3 flex flex-wrap gap-x-2.5 gap-y-0.5 text-xs text-dim empty:hidden"
            data-role="telemetry"
          >
            <span v-if="room.recording">● REC</span>
            <span v-else-if="recordingMissing(room)" :class="missingTone(room)" data-role="no-recording">Pas d'enregistrement</span>
            <span v-if="room.streaming">● LIVE</span>
            <span v-if="room.sceneRole != null">{{ room.sceneRole }}</span>
            <span
              v-if="streamHealth(room) != null"
              :class="streamHealth(room)!.variant === 'warning' ? 'font-semibold text-text' : ''"
            >
              {{ streamHealth(room)!.text }}
            </span>
            <span v-if="room.outboxDepth > 0">{{ room.outboxDepth }} en file</span>
          </div>

          <!-- Pushed to the bottom so that the cards of a row line up. -->
          <div class="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-3 text-xs text-dim">
            <span v-if="health(room) !== 'muette'">{{ footer(room) }}</span>
            <span class="ml-auto flex gap-3 text-[13px]">
              <a
                v-if="features.wall || features.questions"
                :class="LINK"
                target="_blank"
                rel="noopener"
                :href="`/mur?salle=${encodeURIComponent(room.roomId)}`"
              >
                mur ↗
              </a>
              <a
                :class="LINK"
                target="_blank"
                rel="noopener"
                :href="`/orateur/${encodeURIComponent(room.roomId)}`"
              >
                retour orateur ↗
              </a>
            </span>
          </div>
        </div>
      </div>
    </Panel>

    <Panel class="col-span-full" title="Erreurs des régies" data-role="incidents">
      <Empty v-if="incidents.length === 0">Aucune erreur remontée par les salles.</Empty>
      <div v-for="(incident, index) in incidents.slice(0, 30)" v-else :key="`${incident.occurredAt}-${index}`" class="border-t border-edge py-2 text-sm first:border-t-0" data-incident>
        <div class="flex flex-wrap items-baseline gap-x-2">
          <span class="tabular-nums text-dim">{{ new Date(incident.occurredAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) }}</span>
          <strong>{{ rooms.find((room) => room.roomId === incident.roomId)?.name ?? incident.roomId }}</strong>
          <span :class="incident.niveau === 'error' ? 'text-alert' : 'text-warn'">{{ incident.message }}</span>
        </div>
        <div v-if="incident.fichier != null" class="font-mono text-[11px] break-all text-dim">{{ incident.fichier }}</div>
        <div v-if="incident.detail != null" class="text-xs break-all text-dim">{{ incident.detail }}</div>
      </div>
    </Panel>

    <ConfirmDialog
      v-model:open="resyncConfirmation"
      title="Resynchronisation"
      confirm-label="Demander"
      @confirm="confirmResync"
    >
      <label class="mb-[5px] block text-xs text-dim" for="resync-room">Salle à resynchroniser</label>
      <select
        id="resync-room"
        v-model="resyncRoom"
        class="mb-3 w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text"
      >
        <option value="">Toutes les salles</option>
        <option v-for="room in rooms" :key="room.roomId" :value="room.roomId">{{ room.name }}</option>
      </select>
      <span id="resync-text">
        Demander une resynchronisation complète à
        <strong>{{ resyncRoomName ?? 'toutes les salles' }}</strong>.
      </span>
    </ConfirmDialog>
  </div>
</template>
