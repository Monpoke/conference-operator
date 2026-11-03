<script setup lang="ts">
import type { DisplayPayload } from '@conference-operator/contract'
import { Button, Combobox, Dialog } from '@conference-operator/components'
import { timelinePosition } from '@conference-operator/program/selectors'
import { computed, ref, watch } from 'vue'
import { dayKeyOf, openDay, programDays } from '../lib/days.js'
import { featuresOf } from '../lib/features.js'
import { otherRooms } from '../lib/rooms.js'
import { CONSULT_TABS, useConsultStore, type ConsultTab } from '../stores/consult.js'
import { useKeyboardLayer } from '../stores/keyboard.js'
import { useProgramsStore } from '../stores/programs.js'
import QuestionsTab from './QuestionsTab.vue'
import RoomsTab from './RoomsTab.vue'
import Timeline from './Timeline.vue'

const LABELS: Record<ConsultTab, string> = {
  program: 'Programme',
  other: 'Autre salle',
  rooms: 'Salles',
  questions: 'Questions',
}

const props = defineProps<{ payload: DisplayPayload; nowMs: number }>()

const consult = useConsultStore()
const programs = useProgramsStore()

/** The questions tab goes when the hub turned the questions off. */
const tabs = computed(() =>
  featuresOf(props.payload).questions ? CONSULT_TABS : CONSULT_TABS.filter((name) => name !== 'questions'),
)

/*
 * An empty layer, and that is all that is asked of it.
 *
 * It swallows the page's shortcuts while a program is being read: `l` and `h`
 * switch the projection in front of an audience, and an open modal is exactly the
 * moment one types without looking. Escape stays with Reka, which closes only the
 * top layer.
 */
useKeyboardLayer(() => ({}), () => consult.open)

const followedSessions = computed(() =>
  consult.followed == null ? [] : (programs.sessions[consult.followed] ?? []),
)

/**
 * What is playing next door, deduced from the program and the hub's time.
 *
 * We do not receive the other room's state here — and we do not want it: the
 * cached program answers even during an outage, and the hub's time carries the
 * offset, simulated clock included. Without this computation, the modal unrolled a
 * list without saying where one stood in it.
 */
const followedCurrentId = computed(
  () => timelinePosition(followedSessions.value, props.nowMs).current?.id ?? null,
)

const followable = computed(() => otherRooms(props.payload, programs.rooms))

/*
 * The day read, at an event of several.
 *
 * The timeline used to run the days one after the other — 18:30, then 09:00 the
 * next morning — with nothing between them. It opens on the room's own day, the
 * one being lived, and another can be chosen; every opening comes back to today.
 */
const zone = computed(() => props.payload.timezone)
const today = computed(() => dayKeyOf(props.nowMs, zone.value))
const listed = computed(() =>
  consult.tab === 'other' ? followedSessions.value : (props.payload.sessions ?? []),
)
const days = computed(() => programDays(listed.value.map((session) => session.startsAt), zone.value))
const dayOptions = computed(() =>
  days.value.map((entry) => ({
    value: entry.value,
    label: entry.value === today.value ? `${entry.label} · aujourd’hui` : entry.label,
  })),
)
const askedDay = ref<string | null>(null)
watch(
  () => consult.open,
  (open) => {
    if (open) askedDay.value = null
  },
)
const shownDay = computed(() =>
  openDay(days.value.map((entry) => entry.value), today.value, askedDay.value),
)

function ofShownDay<T extends { startsAt: string }>(sessions: T[]): T[] {
  if (days.value.length < 2) return sessions
  return sessions.filter((session) => dayKeyOf(session.startsAt, zone.value) === shownDay.value)
}
</script>

<template>
  <!--
    One height whatever the tab or the room: a shorter program used to re-centre
    the dialog, and it jumped under the hand at every room chosen.
  -->
  <Dialog v-model:open="consult.open" title="Consultation" width="full" height="fixed">
    <div class="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-1.5 border-b border-edge bg-surface pb-3">
      <Button
        v-for="name in tabs"
        :key="name"
        variant="tab"
        size="small"
        :active="consult.tab === name"
        :data-tab="name"
        @click="consult.tab = name"
      >
        {{ LABELS[name] }}
      </Button>
      <!--
        Typed through, not a row of buttons: with a dozen rooms the row took the
        header. Not a native `<select>` either: it opens empty in an OBS dock.
      -->
      <!--
        One field however many days: a row of buttons held two or three and broke
        past that. Typed through and floating, like the room choice — a native
        list opens empty in an OBS dock.
      -->
      <div
        v-if="(consult.tab === 'program' || consult.tab === 'other') && days.length > 1"
        class="flex items-center gap-1.5 border-l border-edge pl-2"
        data-role="consult-days"
      >
        <div class="w-60">
          <Combobox
            :model-value="shownDay"
            :options="dayOptions"
            label="Journée affichée"
            placeholder="Journée…"
            empty="Aucune journée ne correspond."
            @update:model-value="(value) => value != null && (askedDay = value)"
          />
        </div>
        <Button
          v-if="shownDay !== today && days.some((entry) => entry.value === today)"
          variant="tab"
          size="small"
          data-role="consult-today"
          @click="askedDay = today"
        >
          Aujourd’hui
        </Button>
      </div>
      <div v-if="consult.tab === 'other'" class="ml-auto w-[min(22rem,100%)]" data-role="other-room-choice">
        <Combobox
          :model-value="consult.followed"
          :options="followable.map((room) => ({ value: room.id, label: room.name, keywords: room.id }))"
          label="Rechercher une salle"
          placeholder="Rechercher une salle…"
          empty="Aucune salle ne correspond."
          @update:model-value="(id) => id != null && consult.follow(id)"
        />
      </div>
    </div>

    <div>
      <Timeline
        v-if="consult.tab === 'program'"
        :sessions="ofShownDay(payload.sessions ?? [])"
        :time-zone="payload.timezone"
        :current-id="payload.state.currentSession?.id ?? null"
        :now-ms="nowMs"
      />

      <template v-else-if="consult.tab === 'other'">
        <div v-if="consult.followed == null" class="text-xs text-dim">
          Choisissez une salle à suivre.
        </div>
        <Timeline
          v-else
          :sessions="ofShownDay(followedSessions)"
          :time-zone="payload.timezone"
          :current-id="followedCurrentId"
          :now-ms="nowMs"
        />
      </template>

      <RoomsTab v-else-if="consult.tab === 'rooms'" :payload="payload" :now-ms="nowMs" />

      <QuestionsTab v-else-if="featuresOf(payload).questions" :payload="payload" />
      <div v-else class="text-xs text-dim" data-role="questions-off">
        Les questions du public ne sont pas ouvertes pour cet événement.
      </div>
    </div>
  </Dialog>
</template>
