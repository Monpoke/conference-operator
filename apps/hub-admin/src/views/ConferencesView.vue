<script setup lang="ts">
import { isTransitionAllowed } from '@conference-operator/room-state'
import { Badge, Button, ConfirmDialog, Empty, Hint, Panel, useToast, StableLabel } from '@conference-operator/components'
import type { VodStatut } from '@conference-operator/contract'
import { timeFormatter } from '@conference-operator/format'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { dayKeyOf, dayOptions } from '../stores/days.js'
import { planningGrid, PX_PER_MINUTE, horaireReel } from '../stores/planning-grid.js'
import { latestByTake, montagePath, useMontageStore } from '../stores/montage.js'
import FeedbackIdDialog from '../components/FeedbackIdDialog.vue'
import VodFolderDialog from '../components/VodFolderDialog.vue'
import {
  canPin,
  overrideChoice,
  partnersByRoom,
  placeInDay,
  swapBlocked,
  swapPartners,
  useConferencesStore,
  type FeedbackCheck,
  type PlannedSession,
  type SessionState,
} from '../stores/conferences.js'

/**
 * The talks, and the schedule.
 *
 * Two tables in the same tab because they answer two questions asked one after the
 * other: "where are we" and then "what comes next". Splitting them into two views
 * would mean navigating between them all day long.
 *
 * Every time is read in the **event's** time zone. The console opens from
 * anywhere — a train, another country — and the program does not shift: showing
 * the machine's own time would announce a talk an hour too early to whoever rings
 * the room.
 */
const store = useConferencesStore()
const { states, planning, hasActiveProgram, room, pins } = storeToRefs(store)
const toast = useToast()

const zone = computed(() => planning.value?.timezone ?? 'Europe/Paris')

const hour = (iso: string | null | undefined): string =>
  iso == null ? '—' : timeFormatter(zone.value).format(new Date(iso))

const day = ref('')
const planningDays = computed(() => dayOptions((planning.value?.sessions ?? []).map((session) => session.startsAt), zone.value))
const slots = computed(() =>
  (planning.value?.sessions ?? []).filter(
    (session) =>
      (room.value === '' || session.roomId === room.value) &&
      (day.value === '' || dayKeyOf(session.startsAt, zone.value) === day.value),
  ),
)

/**
 * The day only appears when there is more than one.
 *
 * At a one-day event it would say nothing and take the title's place.
 */
const dayFormatter = computed(
  () =>
    new Intl.DateTimeFormat('fr-FR', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      timeZone: zone.value,
    }),
)

const severalDays = computed(
  () => new Set(slots.value.map((s) => dayFormatter.value.format(new Date(s.startsAt)))).size > 1,
)

/** The hub's time, not the browser's: it may be simulated, and it is authoritative. */
const now = computed(() =>
  planning.value == null ? Date.now() : Date.parse(planning.value.serverTime),
)

/** What the room did first: a talk started late or ended early follows the facts, not the program. */
function placeOf(session: PlannedSession): 'a-venir' | 'en-cours' | 'passe' {
  if (session.endedAt != null) return 'passe'
  if (session.startedAt != null) return 'en-cours'
  return placeInDay(session, now.value)
}

function slotLabel(session: PlannedSession): string {
  const day = severalDays.value
    ? `${dayFormatter.value.format(new Date(session.startsAt))} `
    : ''
  const end = session.endsAt == null ? '' : `–${hour(session.endsAt)}`
  return `${day}${hour(session.startsAt)}${end}`
}

/** What is left of the slot: the overrun is what triggers a decision. */
function remaining(state: SessionState): { text: string; tone: string } {
  if (state.status !== 'running' || state.remainingMs == null) {
    return { text: '—', tone: 'text-dim' }
  }
  const minutes = Math.round(state.remainingMs / 60000)
  if (minutes >= 0) {
    return { text: `${minutes} min`, tone: minutes <= 5 ? 'text-warn' : '' }
  }
  return { text: `+${Math.abs(minutes)} min`, tone: 'font-semibold text-alert' }
}

/**
 * The actions follow the lifecycle table, not a condition written here.
 *
 * It is the table the hub applies on write and the control app reads to grey out
 * its buttons. A hand-written condition said the same thing — but by a maintained
 * coincidence, and it is that kind of coincidence that stops being true the day the
 * table changes.
 */
function actions(state: SessionState): { label: string; action: 'start' | 'end' | 'reset'; danger: boolean }[] {
  const offered: { label: string; action: 'start' | 'end' | 'reset'; danger: boolean }[] = []
  if (isTransitionAllowed(state.status as never, 'end')) {
    offered.push({ label: 'Terminer', action: 'end', danger: false })
  }
  if (isTransitionAllowed(state.status as never, 'start')) {
    offered.push({
      label: state.status === 'ended' ? 'Relancer' : 'Commencer',
      action: 'start',
      danger: false,
    })
  }
  if (isTransitionAllowed(state.status as never, 'reset')) {
    offered.push({ label: 'Remettre à venir', action: 'reset', danger: true })
  }
  return offered
}

async function act(state: SessionState, action: 'start' | 'end' | 'reset'): Promise<void> {
  try {
    await store.decide(state.sessionId, action)
    toast.say('Conférence mise à day')
  } catch {
    /* already reported */
  }
}

/**
 * What actually happened: what the lifecycle really recorded.
 *
 * The full instant goes into the tooltip — the time is enough to read the day, the
 * whole date serves editing and the VOD export.
 */
function actual(session: PlannedSession): { text: string; running: boolean; title: string } | null {
  if (session.startedAt == null) return null
  const by =
    session.decidedBy == null
      ? ''
      : ` · décidé par ${session.decidedBy === 'auto' ? 'la règle horaire' : session.decidedBy}`
  return {
    text: hour(session.startedAt),
    running: session.endedAt == null,
    title: session.startedAt + (session.endedAt == null ? '' : ` → ${session.endedAt}`) + by,
  }
}

const decisions = computed(
  () => (planning.value?.sessions ?? []).filter((s) => s.overriddenAs != null).length,
)

async function changeOverride(session: PlannedSession, menu: HTMLSelectElement): Promise<void> {
  // The contract accepts only these two words, or nothing: the menu offers no
  // others, but it is the type that guarantees it rather than trust.
  const action = menu.value === '' ? null : (menu.value as 'talk' | 'break')
  const before = session.overriddenAs ?? ''
  try {
    await store.override(session.id, action)
    toast.say(
      action === 'break'
        ? 'Créneau considéré comme break'
        : action === 'talk'
          ? 'Créneau considéré comme conférence'
          : 'Créneau rendu au programme',
    )
  } catch {
    /*
     * Put back by hand to its previous value.
     *
     * Reloading the store is not enough: the data comes back identical, so Vue sees
     * no change to propagate and the `<select>` keeps the option the operator
     * clicked. The menu would then stay on a decision nobody saved — one that
     * reaches neither the rooms nor the QR codes.
     */
    menu.value = before
  }
}

/*
 * The two emergency gestures: swapping two talks' slots, and forcing a room's
 * current talk. Both correct what the hub **serves**, so every screen follows —
 * and both are read back from the hub rather than patched here.
 */
const moved = computed(
  () => (planning.value?.sessions ?? []).filter((s) => s.movedTo != null).length,
)

function titleOf(sessionId: string | null | undefined): string {
  return planning.value?.sessions.find((s) => s.id === sessionId)?.title ?? sessionId ?? '—'
}

/** Among the whole program, not the filtered room: a swap crosses rooms. */
function partnerGroups(session: PlannedSession): ReturnType<typeof partnersByRoom> {
  return partnersByRoom(swapPartners(session, planning.value?.sessions ?? [], zone.value))
}

async function changeSwap(session: PlannedSession, menu: HTMLSelectElement): Promise<void> {
  const other = menu.value
  // The menu is a trigger, not a state: it goes back to its prompt whatever the
  // outcome, the result reads in the "Déplacée" badge.
  menu.value = ''
  if (other === '') return
  try {
    await store.swap(session.id, other)
    toast.say(`Créneaux échangés avec « ${titleOf(other)} »`)
  } catch {
    /* already reported */
  }
}

function isPinned(session: PlannedSession): boolean {
  return session.roomId != null && pins.value[session.roomId] === session.id
}

async function changePin(session: PlannedSession, pinned: boolean): Promise<void> {
  if (session.roomId == null) return
  try {
    await store.pin(session.roomId, pinned ? session.id : null)
    toast.say(pinned ? `« ${session.title} » forcée en salle` : 'Salle rendue à son horaire')
  } catch {
    /* already reported */
  }
}

const resetOpen = ref(false)

async function confirmResetSlots(): Promise<void> {
  try {
    await store.resetSlots()
    toast.say('Créneaux rendus au programme')
  } catch {
    /* already reported */
  }
}

const check = ref<FeedbackCheck | null>(null)
const checkError = ref('')
const checking = ref(false)

async function checkLinks(): Promise<void> {
  checking.value = true
  checkError.value = ''
  check.value = null
  try {
    check.value = await store.checkFeedback()
  } catch (cause) {
    checkError.value = cause instanceof Error ? cause.message : 'Contrôle impossible.'
  } finally {
    checking.value = false
  }
}

const feedbackOpen = ref(false)
const feedbackSlot = ref<PlannedSession | null>(null)

function openFeedback(session: PlannedSession): void {
  feedbackSlot.value = session
  feedbackOpen.value = true
}

const vodOpen = ref(false)
const vodSlot = ref<PlannedSession | null>(null)

function openVod(session: PlannedSession): void {
  vodSlot.value = session
  vodOpen.value = true
}

/**
 * The « captation » button's colour: how far the talk's capture got.
 *
 * The evening of the strike, the list is read for one thing — which rush is still
 * on a machine about to be unplugged, which one failed — and a column of identical
 * grey buttons answered neither without opening them one by one. Neutral when
 * nothing was taken: a colour on every row would say nothing.
 */
const VOD_TONES: Record<VodStatut, string> = {
  aucune: '',
  'en-cours': 'border-alert text-alert animate-pulse',
  'sur-la-machine': 'border-warn text-warn',
  televersement: 'border-brand2 text-brand2',
  'sur-le-stockage': 'border-brand text-brand',
  montage: 'border-brand text-brand',
  'a-valider': 'border-warn bg-warn-soft text-warn',
  prete: 'border-ok bg-ok-soft text-ok',
  erreur: 'border-alert bg-alert-soft text-alert',
  'sans-captation': 'text-dim',
}

function vodOf(session: PlannedSession): { statut: VodStatut; detail: string } {
  return store.vodStatuts[session.id] ?? { statut: 'aucune', detail: 'Où en est la captation de cette conférence' }
}

/* ---------- The grid and the talk looked at ---------- */
const dayKey = (startsAt: string) => dayFormatter.value.format(new Date(startsAt))
const days = computed(() => planningGrid(slots.value, planning.value?.rooms ?? [], dayKey))
const columnsTemplate = (count: number) => ({ gridTemplateColumns: `3.25rem repeat(${count}, minmax(0, 1fr))` })
const nowPx = (fromMs: number, heightPx: number): number | null => {
  const px = ((now.value - fromMs) / 60_000) * PX_PER_MINUTE
  return px >= 0 && px <= heightPx ? px : null
}

const selectedId = ref<string | null>(null)
const selected = computed(() => planning.value?.sessions.find((session) => session.id === selectedId.value) ?? null)
const stateOf = (sessionId: string) => states.value.find((state) => state.sessionId === sessionId) ?? null
const selectedState = computed(() => (selectedId.value == null ? null : stateOf(selectedId.value)))
/** A talk still running that the program no longer lists must stay within reach. */
const orphans = computed(() => states.value.filter((state) => !(planning.value?.sessions ?? []).some((session) => session.id === state.sessionId)))
const isCapturable = (session: PlannedSession) => session.kind !== 'break' && session.sharedFrom == null
/** A room nobody records has nothing to report: the tag would only add noise to its column. */
const showsVodTag = (session: PlannedSession) =>
  isCapturable(session) && session.sansCaptation !== true && vodOf(session).statut !== 'sans-captation'

/** Where a slot stands, read from its colour across the whole day. */
const PLACE_TONES = {
  'a-venir': 'border-dim/50 bg-surface',
  'en-cours': 'border-brand bg-[color-mix(in_oklab,var(--color-brand)_28%,var(--color-surface))]',
  passe: 'border-ok/70 bg-ok-soft',
} as const
const BREAK_TONES = {
  'a-venir': 'border-dashed border-dim/50 text-dim',
  'en-cours': 'border-dashed border-brand text-dim',
  passe: 'border-dashed border-ok/50 text-dim',
} as const
const LEGEND = [
  { label: 'À venir', tone: PLACE_TONES['a-venir'] },
  { label: 'En cours', tone: PLACE_TONES['en-cours'] },
  { label: 'Terminé', tone: PLACE_TONES.passe },
]

const montages = useMontageStore()
const selectedTakes = ref<{ path: string; label: string }[]>([])
async function select(session: PlannedSession): Promise<void> {
  selectedId.value = session.id
  selectedTakes.value = []
  if (!isCapturable(session)) return
  const jobs = await montages.forSession(session.id).catch(() => [])
  if (selectedId.value !== session.id) return
  const takes = latestByTake(jobs)
  selectedTakes.value = takes.map((job, index) => ({
    path: montagePath(session.id, job.sidecarUploadId),
    label: takes.length > 1 ? `Ouvrir le montage, prise ${index + 1}` : 'Ouvrir le montage',
  }))
}
</script>

<template>
  <div id="conferences-view" class="grid items-start gap-3.5 lg:grid-cols-[minmax(0,1fr)_minmax(340px,400px)]">
    <section class="min-w-0">
      <div class="mb-2.5 flex flex-wrap items-center gap-2">
        <select
          id="planning-room"
          v-model="room"
          class="w-auto rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text"
          aria-label="Salle affichée"
        >
          <option value="">Toutes les salles</option>
          <option v-for="option in planning?.rooms ?? []" :key="option.id" :value="option.id">{{ option.name }}</option>
        </select>
        <select id="planning-day" v-model="day" class="w-auto rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text" aria-label="Jour affiché">
          <option value="">Tous les jours</option>
          <option v-for="option in planningDays" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <Button id="btn-check-feedback" size="small" :disabled="checking" @click="checkLinks">Vérifier les liens</Button>
        <span v-if="decisions > 0" id="planning-decisions" class="text-xs text-warn">
          {{ decisions }} décision{{ decisions > 1 ? 's' : '' }} en vigueur
        </span>
        <span v-if="moved > 0" id="planning-moved" class="text-xs text-warn">
          {{ moved }} conférence{{ moved > 1 ? 's' : '' }} déplacée{{ moved > 1 ? 's' : '' }}
        </span>
        <Button v-if="moved > 0" id="btn-reset-slots" size="small" variant="danger" @click="resetOpen = true">
          Rendre les créneaux au programme
        </Button>
      </div>

      <div v-if="checking || check != null || checkError !== ''" id="check-feedback" class="mb-2.5">
        <Hint v-if="checking" class="mt-0">Interrogation d'OpenFeedback…</Hint>
        <Hint v-else-if="checkError !== ''" class="mt-0 text-alert">{{ checkError }}</Hint>
        <Hint v-else-if="check != null" class="mt-0">
          <template v-if="!check.projetTrouve">
            <strong class="text-alert">Projet « {{ check.projet }} » introuvable chez OpenFeedback.</strong>
            {{ check.detail }}
          </template>
          <template v-else-if="check.talksConnus == null"><strong>Projet trouvé.</strong> {{ check.detail }}</template>
          <template v-else-if="check.manquants.length === 0">
            <strong class="text-ok">{{ check.talksConnus }} talks chez OpenFeedback, tous les créneaux ont le leur.</strong>
            {{ check.detail }}
          </template>
          <template v-else>
            <strong class="text-warn">{{ check.manquants.length }} créneau{{ check.manquants.length > 1 ? 'x' : '' }} sans page OpenFeedback</strong>
            <span class="text-dim"> sur {{ check.talksConnus }} talks connus.</span>
            {{ check.detail }}
            <ul class="mt-1.5 list-disc pl-4">
              <li v-for="missing in check.manquants" :key="missing.feedbackId">
                {{ missing.title }} <span class="font-mono text-[11px] text-dim">{{ missing.feedbackId }}</span>
              </li>
            </ul>
          </template>
        </Hint>
      </div>

      <Hint v-if="planning != null && planning.openFeedbackProjectId == null" id="planning-feedback-hint" class="mt-0 mb-2.5">
        <strong>Aucun projet OpenFeedback réglé</strong> : les salles ne projettent aucun QR « notez ce talk ». Il se
        règle dans <strong>Réglages → L'événement</strong>.
      </Hint>

      <ul v-if="slots.length > 0" class="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-dim" data-role="legende">
        <li v-for="item in LEGEND" :key="item.label" class="flex items-center gap-1.5">
          <span class="inline-block size-3 rounded-sm border" :class="item.tone" aria-hidden="true" />{{ item.label }}
        </li>
      </ul>

      <Empty v-if="!hasActiveProgram || planning == null || planning.sessions.length === 0">
        Aucun programme actif. Il s'importe depuis les réglages.
      </Empty>
      <Empty v-else-if="slots.length === 0">Aucun créneau pour ce choix de salle et de jour.</Empty>

      <div v-for="day in days" v-else :key="day.key" class="mb-5" :data-day="day.key">
        <h2 v-if="severalDays" class="mb-2 text-sm font-semibold">{{ day.key }}</h2>
        <!-- One column per room on a large screen; on a phone, the rooms follow each other as lists. -->
        <div class="lg:grid lg:gap-x-1.5" :style="columnsTemplate(day.columns.length)">
          <div class="relative max-lg:hidden" :style="{ height: `${day.heightPx + 28}px` }" aria-hidden="true">
            <span
              v-for="tick in day.hours"
              :key="tick.ms"
              class="absolute right-2 -translate-y-1/2 text-[11px] tabular-nums text-dim"
              :style="{ top: `${tick.topPx + 28}px` }"
            >{{ hour(new Date(tick.ms).toISOString()) }}</span>
          </div>

          <div v-for="column in day.columns" :key="column.key" class="min-w-0 max-lg:mb-4" :data-room="column.key">
            <h3 class="sticky top-0 z-10 flex h-7 items-center truncate bg-canvas text-[11px] font-semibold tracking-[.08em] text-text uppercase">
              {{ column.name }}
            </h3>
            <div class="relative flex flex-col gap-1 lg:block" :style="{ '--day-h': `${day.heightPx}px` }">
              <div class="pointer-events-none absolute inset-0 max-lg:hidden lg:h-[var(--day-h)]" aria-hidden="true">
                <div v-for="tick in day.hours" :key="tick.ms" class="absolute inset-x-0 border-t border-edge" :style="{ top: `${tick.topPx}px` }" />
              </div>
              <div class="max-lg:hidden lg:h-[var(--day-h)]" aria-hidden="true" />
              <div
                v-if="nowPx(day.fromMs, day.heightPx) != null"
                class="pointer-events-none absolute inset-x-0 z-[5] border-t border-alert/70 max-lg:hidden"
                data-role="maintenant"
                :style="{ top: `${nowPx(day.fromMs, day.heightPx)}px` }"
              />
              <button
                v-for="slot in column.slots"
                :key="slot.session.id"
                type="button"
                class="flex w-full min-w-0 overflow-hidden rounded-lg border px-2 text-left text-[13px] transition-colors hover:border-brand focus-visible:outline-2 focus-visible:outline-brand lg:absolute lg:inset-x-0 lg:top-[var(--top)] lg:h-[var(--h)]"
                :class="[
                  slot.heightPx < 40 ? 'flex-row items-center gap-1.5 py-0 text-xs' : 'flex-col items-start py-1',
                  slot.session.kind === 'break' ? BREAK_TONES[placeOf(slot.session)] : PLACE_TONES[placeOf(slot.session)],
                  selectedId === slot.session.id ? 'z-[6] ring-2 ring-brand' : '',
                ]"
                :style="{ '--top': `${slot.topPx}px`, '--h': `${slot.heightPx}px` }"
                :data-slot="slot.session.id"
                :data-when="placeOf(slot.session)"
                :aria-pressed="selectedId === slot.session.id"
                :aria-label="`${hour(slot.session.startsAt)} ${slot.session.title}`"
                :title="slot.heightPx < 18 ? `${hour(slot.session.startsAt)} ${slot.session.title}` : undefined"
                @click="select(slot.session)"
              >
                <span v-if="slot.heightPx >= 18" class="flex shrink-0 items-baseline gap-1.5 text-[11px] tabular-nums text-dim" :class="slot.heightPx < 40 ? 'order-last' : 'w-full'">
                  {{ hour(slot.session.startsAt) }}
                  <!-- On the hour's row: a twenty-minute talk would lose its title to a row of its own. -->
                  <span v-if="slot.heightPx >= 40 && slot.session.kind !== 'break' && horaireReel(slot.session, hour) != null" class="whitespace-nowrap text-text" :data-reel="slot.session.id">
                    → {{ horaireReel(slot.session, hour)!.heures }}<template v-if="horaireReel(slot.session, hour)!.retard != null"> · <span :class="horaireReel(slot.session, hour)!.enRetard ? 'font-semibold text-warn' : 'text-dim'">{{ horaireReel(slot.session, hour)!.retard }}</span></template>
                  </span>
                  <span v-if="placeOf(slot.session) === 'en-cours' && slot.heightPx >= 40" class="font-semibold text-brand">en ce moment</span>
                  <span
                    v-if="stateOf(slot.session.id) != null && stateOf(slot.session.id)!.status === 'running'"
                    class="ml-auto"
                    :class="remaining(stateOf(slot.session.id)!).tone"
                  >{{ remaining(stateOf(slot.session.id)!).text }}</span>
                  <!-- With the hour and not below the text: a twenty-minute talk has no room for a second row. -->
                  <span
                    v-if="showsVodTag(slot.session)"
                    class="rounded border border-edge px-1 text-[10px] leading-4"
                    :class="[VOD_TONES[vodOf(slot.session).statut], stateOf(slot.session.id)?.status === 'running' ? '' : 'ml-auto']"
                    :data-vod-session="slot.session.id"
                    :data-vod-statut="vodOf(slot.session).statut"
                    :title="vodOf(slot.session).detail"
                  >VOD</span>
                </span>
                <span v-if="slot.heightPx >= 18" class="min-w-0 font-semibold" :class="[slot.session.kind === 'break' ? 'font-normal' : '', slot.heightPx < 76 ? 'truncate' : 'line-clamp-2', slot.heightPx < 40 ? 'flex-1' : 'w-full']" :title="slot.session.title">{{ slot.session.title }}</span>
                <span v-if="slot.heightPx >= 76 && slot.session.speakers.length > 0" class="w-full truncate text-xs text-dim">{{ slot.session.speakers.join(', ') }}</span>
                <span v-if="slot.heightPx >= 60 && (slot.session.movedTo != null || isPinned(slot.session))" class="mt-auto flex flex-wrap items-center gap-1 pt-0.5">
                  <Badge v-if="slot.session.movedTo != null" variant="warning" class="px-1.5 py-0 text-[10px]" :data-moved="slot.session.id" :title="`Occupe le créneau de ${titleOf(slot.session.movedTo)}`">Déplacée</Badge>
                  <Badge v-if="isPinned(slot.session)" variant="alert" class="px-1.5 py-0 text-[10px]" :data-pinned="slot.session.id" title="Forcée en cours dans sa salle, quelle que soit l'heure">Forcée</Badge>
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <Panel v-if="orphans.length > 0" title="Hors du programme actif" class="mt-3">
        <div v-for="state in orphans" :key="state.sessionId" class="flex flex-wrap items-center gap-2 border-t border-edge py-2 text-sm first:border-t-0" :data-session="state.sessionId">
          <span class="min-w-0 flex-1">{{ state.title ?? state.sessionId }}</span>
          <span :class="remaining(state).tone">{{ remaining(state).text }}</span>
          <Button v-for="offered in actions(state)" :key="offered.action" size="small" :variant="offered.danger ? 'danger' : 'neutral'" @click="act(state, offered.action)">{{ offered.label }}</Button>
        </div>
      </Panel>
    </section>

    <!-- Beside the grid on a computer, it stays in view while the day scrolls; on a phone, it rises from the bottom. -->
    <aside
      class="min-w-0 lg:sticky lg:top-3 lg:max-h-[calc(100dvh-1.5rem)] lg:overflow-y-auto"
      :class="selected == null ? 'max-lg:hidden' : 'max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-40 max-lg:max-h-[80dvh] max-lg:overflow-y-auto'"
      data-role="detail-talk"
    >
      <Panel v-if="selected == null">
        <p class="text-sm text-dim">Choisis un créneau pour voir son état, son feedback, sa captation et ses gestes d'urgence.</p>
      </Panel>

      <Panel v-else>
        <div class="flex items-start gap-2">
          <h2 class="min-w-0 flex-1 text-base font-semibold">{{ selected.title }}</h2>
          <Button size="small" aria-label="Fermer le détail" data-role="fermer-detail" @click="selectedId = null">×</Button>
        </div>
        <p class="mt-0.5 text-sm text-dim">{{ selected.roomName ?? 'Sans salle' }}<template v-if="selected.speakers.length > 0"> · {{ selected.speakers.join(', ') }}</template></p>
        <p v-if="selected.sharedFrom != null" class="mt-0.5 text-xs text-dim">pause commune, héritée d'une autre salle</p>

        <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt class="text-dim">Prévu</dt>
          <dd class="tabular-nums">{{ slotLabel(selected) }}</dd>
          <dt class="text-dim">Réel</dt>
          <dd class="tabular-nums">
            <span v-if="actual(selected) == null" class="text-dim">—</span>
            <span v-else :title="actual(selected)!.title">
              {{ actual(selected)!.text }}–<span v-if="actual(selected)!.running" class="text-brand">en cours</span><template v-else>{{ hour(selected.endedAt) }}</template>
            </span>
          </dd>
        </dl>

        <div v-if="selectedState != null" class="mt-3 border-t border-edge pt-3" :data-session="selectedState.sessionId">
          <p class="flex flex-wrap items-center gap-2 text-sm">
            <Badge :variant="selectedState.status === 'running' ? 'running' : 'ended'">{{ selectedState.status === 'running' ? 'en cours' : 'terminée' }}</Badge>
            <span :class="remaining(selectedState).tone">{{ remaining(selectedState).text }}</span>
            <span v-if="selectedState.decidedBy != null" class="text-dim">{{ selectedState.decidedBy === 'auto' ? 'auto' : selectedState.decidedBy }}</span>
          </p>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <Button v-for="offered in actions(selectedState)" :key="offered.action" size="small" :variant="offered.danger ? 'danger' : 'neutral'" @click="act(selectedState!, offered.action)">{{ offered.label }}</Button>
          </div>
        </div>

        <div v-if="isCapturable(selected)" class="mt-3 border-t border-edge pt-3">
          <h3 class="mb-1.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">Vidéo</h3>
          <p class="text-sm" :class="VOD_TONES[vodOf(selected).statut]" data-role="detail-vod">{{ vodOf(selected).detail }}</p>
          <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Button size="small" :data-vod-open="selected.id" @click="openVod(selected!)">Captation et fichiers</Button>
            <a v-for="take in selectedTakes" :key="take.path" :href="take.path" class="text-sm text-brand underline" data-role="detail-montage">{{ take.label }}</a>
          </div>
        </div>

        <div v-if="selected.kind !== 'break'" class="mt-3 border-t border-edge pt-3">
          <h3 class="mb-1.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">Feedback</h3>
          <div class="flex flex-wrap items-center gap-2">
            <a v-if="selected.feedbackUrl != null" class="text-sm font-semibold text-brand no-underline" target="_blank" rel="noopener" :href="selected.feedbackUrl">Page de notation ↗</a>
            <span v-else class="text-sm text-dim">Pas de page de notation</span>
            <Button
              size="small"
              :class="selected.feedbackIdOverride != null ? 'text-warn' : 'text-dim'"
              :data-feedback-session="selected.id"
              :title="selected.feedbackIdOverride != null ? 'Identifiant OpenFeedback corrigé' : 'Identifiant OpenFeedback'"
              @click="openFeedback(selected!)"
            ><StableLabel :current="selected.feedbackIdOverride != null ? 'Identifiant ✱' : 'Identifiant'" :labels="['Identifiant ✱', 'Identifiant']" /></Button>
          </div>
        </div>

        <details class="mt-3 border-t border-edge pt-3" data-role="detail-urgence" :open="selected.overriddenAs != null || selected.movedTo != null || isPinned(selected)">
          <summary class="cursor-pointer text-[11px] font-semibold tracking-[.14em] text-dim uppercase">Gestes d'urgence</summary>
          <p class="mt-1.5 text-xs text-dim">Toutes les salles suivent ces changements.</p>
          <p v-if="selected.sharedFrom != null" class="mt-2 text-sm text-dim" title="Pause héritée d'une autre salle">Se corrige sur la pause d'origine.</p>
          <label v-else class="mt-2 block text-xs text-dim">Nature du créneau
            <select
              class="mt-1 block w-full rounded-lg border border-edge bg-canvas px-2 py-1.5 text-sm text-text"
              :data-session-action="selected.id"
              :value="selected.overriddenAs ?? ''"
              @change="changeOverride(selected!, $event.target as HTMLSelectElement)"
            >
              <option value="">Comme au programme : {{ overrideChoice(selected).scheduled === 'break' ? 'pause' : 'conférence' }}</option>
              <option :value="overrideChoice(selected).action">{{ overrideChoice(selected).action === 'talk' ? 'Considérer comme conférence' : 'Considérer comme pause' }}</option>
            </select>
          </label>
          <template v-if="selected.kind === 'talk' && selected.sharedFrom == null">
            <label class="mt-2 block text-xs text-dim">Échanger le créneau
              <select
                class="mt-1 block w-full rounded-lg border border-edge bg-canvas px-2 py-1.5 text-sm text-text disabled:opacity-40"
                :data-swap-session="selected.id"
                :disabled="swapBlocked(selected) != null || partnerGroups(selected).length === 0"
                :title="swapBlocked(selected) ?? (partnerGroups(selected).length === 0 ? 'Aucune autre conférence à venir ce jour-là' : 'Échanger salle et horaires avec une autre conférence')"
                value=""
                @change="changeSwap(selected!, $event.target as HTMLSelectElement)"
              >
                <option value="">Échanger avec…</option>
                <optgroup v-for="group in partnerGroups(selected)" :key="group.room" :label="group.room">
                  <option v-for="other in group.sessions" :key="other.id" :value="other.id">{{ hour(other.startsAt) }} — {{ other.title }}</option>
                </optgroup>
              </select>
            </label>
            <div v-if="canPin(selected)" class="mt-2">
              <Button v-if="isPinned(selected)" size="small" :data-unpin-session="selected.id" title="Rendre la salle à son horaire" @click="changePin(selected!, false)">Libérer la salle</Button>
              <Button v-else size="small" :data-pin-session="selected.id" title="La salle passe sur cette conférence maintenant, quelle que soit l'heure" @click="changePin(selected!, true)">Forcer en cours</Button>
            </div>
          </template>
        </details>
      </Panel>
    </aside>

    <ConfirmDialog
      v-model:open="resetOpen"
      title="Rendre les créneaux au programme"
      :detail="`Les ${moved} conférence${moved > 1 ? 's' : ''} déplacée${moved > 1 ? 's' : ''} retrouvent la salle et l'horaire de l'export. Toutes les salles suivent.`"
      confirm-label="Rendre les créneaux"
      danger
      @confirm="confirmResetSlots"
    />
    <FeedbackIdDialog v-model:open="feedbackOpen" :session="feedbackSlot" />
    <VodFolderDialog v-model:open="vodOpen" :session="vodSlot" :timezone="zone" />
  </div>
</template>
