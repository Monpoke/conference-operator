<script setup lang="ts">
import type { DisplayPayload } from '@cloudnord/contract'
import { Button, Dialog } from '@cloudnord/components'
import { timelinePosition } from '@cloudnord/program/selectors'
import { computed } from 'vue'
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
</script>

<template>
  <Dialog v-model:open="consult.open" title="Consultation" width="full">
    <div class="mb-3 flex flex-wrap items-center gap-1.5 border-b border-edge pb-3">
      <Button
        v-for="name in CONSULT_TABS"
        :key="name"
        variant="tab"
        size="small"
        :active="consult.tab === name"
        :data-tab="name"
        @click="consult.tab = name"
      >
        {{ LABELS[name] }}
      </Button>
      <select
        v-if="consult.tab === 'other'"
        class="max-w-[220px] rounded-lg border border-edge bg-canvas px-3 py-2 text-[13px] text-text focus:border-brand focus:outline-none"
        data-role="other-room-choice"
        :value="consult.followed ?? ''"
        @change="consult.follow(($event.target as HTMLSelectElement).value)"
      >
        <option value="">Choisir une salle…</option>
        <option v-for="room in followable" :key="room.id" :value="room.id">{{ room.name }}</option>
      </select>
    </div>

    <div class="max-h-[62vh] overflow-y-auto">
      <Timeline
        v-if="consult.tab === 'program'"
        :sessions="payload.sessions"
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
          :sessions="followedSessions"
          :time-zone="payload.timezone"
          :current-id="followedCurrentId"
          :now-ms="nowMs"
        />
      </template>

      <RoomsTab v-else-if="consult.tab === 'rooms'" :payload="payload" :now-ms="nowMs" />

      <QuestionsTab v-else :payload="payload" />
    </div>
  </Dialog>
</template>
