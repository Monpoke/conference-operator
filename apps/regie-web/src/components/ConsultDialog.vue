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
  programme: 'Programme',
  autre: 'Autre salle',
  salles: 'Salles',
  questions: 'Questions',
}

const props = defineProps<{ payload: DisplayPayload; nowMs: number }>()

const consult = useConsultStore()
const programs = useProgramsStore()

/*
 * Une couche vide, et c'est tout ce qu'on lui demande.
 *
 * Elle avale les raccourcis de la page pendant qu'on lit un programme : `l` et
 * `h` basculent la projection devant du public, et une modale ouverte est
 * exactement le moment où l'on tape sans regarder. Échap reste à Reka, qui ne
 * ferme que la couche du dessus.
 */
useKeyboardLayer(() => ({}), () => consult.open)

const followedSessions = computed(() =>
  consult.followed == null ? [] : (programs.sessions[consult.followed] ?? []),
)

/**
 * Ce qui se joue à côté, déduit du programme et de l'heure du hub.
 *
 * On ne reçoit pas l'état de l'autre salle ici — et on n'en veut pas : le
 * programme mis en cache répond même pendant une coupure, et l'heure du hub
 * porte le décalage, heure simulée comprise. Sans ce calcul, la modale
 * déroulait une liste sans dire où on en était.
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
        :data-onglet="name"
        @click="consult.tab = name"
      >
        {{ LABELS[name] }}
      </Button>
      <select
        v-if="consult.tab === 'autre'"
        class="max-w-[220px] rounded-lg border border-edge bg-canvas px-3 py-2 text-[13px] text-text focus:border-brand focus:outline-none"
        data-role="choix-autre-salle"
        :value="consult.followed ?? ''"
        @change="consult.follow(($event.target as HTMLSelectElement).value)"
      >
        <option value="">Choisir une salle…</option>
        <option v-for="room in followable" :key="room.id" :value="room.id">{{ room.name }}</option>
      </select>
    </div>

    <div class="max-h-[62vh] overflow-y-auto">
      <Timeline
        v-if="consult.tab === 'programme'"
        :sessions="payload.sessions"
        :time-zone="payload.timezone"
        :current-id="payload.state.currentSession?.id ?? null"
        :now-ms="nowMs"
      />

      <template v-else-if="consult.tab === 'autre'">
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

      <RoomsTab v-else-if="consult.tab === 'salles'" :payload="payload" :now-ms="nowMs" />

      <QuestionsTab v-else :payload="payload" />
    </div>
  </Dialog>
</template>
