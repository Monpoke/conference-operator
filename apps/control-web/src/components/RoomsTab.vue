<script setup lang="ts">
import type { DisplayPayload } from '@cloudnord/contract'
import { Badge } from '@cloudnord/components'
import { outlineOf } from '@cloudnord/room-state'
import { computed } from 'vue'
import { roomState } from '../lib/rooms.js'
import { useProgramsStore } from '../stores/programs.js'

/**
 * The rooms' state, as the hub knows it.
 *
 * The label accompanies the dot, and that is not redundancy: a colour on its own
 * cannot be read by somebody who does not tell them apart, and nothing else here
 * says what is playing.
 */
const props = defineProps<{ payload: DisplayPayload; nowMs: number }>()

const programs = useProgramsStore()

const rows = computed(() =>
  (props.payload.diagnostics?.rooms ?? []).map((room) => {
    const state = roomState(props.payload, room.roomId, programs.sessions[room.roomId] ?? [], props.nowMs)
    const cut = room.connectivity !== 'ONLINE'
    return {
      id: room.roomId,
      name: room.name,
      scene: room.sceneRole ?? 'scène inconnue',
      queue: room.outboxDepth > 0 ? `${room.outboxDepth} en attente` : '',
      recording: room.recording,
      dot: `${state.fill}${outlineOf(room.connectivity)}`.trim(),
      // A silent room says nothing of what is playing there: reusing the program's
      // word would suggest we still know.
      word: cut ? 'salle muette' : state.word,
      text: state.text,
    }
  }),
)

/**
 * A stale view rather than an emptied one: an empty list would read as "no rooms".
 *
 * Past a minute, what is displayed is no longer the rooms' state but our memory of
 * it, and the difference matters when deciding whether to wait.
 */
const staleMinutes = computed(() => {
  const at = props.payload.diagnostics?.roomsRefreshedAt
  if (at == null) return null
  const seconds = Math.round((Date.now() - Date.parse(at)) / 1000)
  return seconds > 60 ? Math.round(seconds / 60) : null
})
</script>

<template>
  <div v-if="rows.length === 0" class="text-xs text-dim">Aucune salle connue du hub.</div>
  <template v-else>
    <div
      v-for="row in rows"
      :key="row.id"
      class="grid grid-cols-[1fr_auto_auto] items-center gap-2.5 border-t border-edge py-2 text-[13px] first:border-t-0"
      :data-room="row.id"
    >
      <div>
        <div class="font-semibold">{{ row.name }}</div>
        <div class="text-xs text-dim">
          {{ row.scene }}{{ row.queue === '' ? '' : ` · ${row.queue}` }}
        </div>
      </div>
      <div><Badge v-if="row.recording" class="running">rec</Badge></div>
      <div class="flex items-center gap-1.5 text-xs" :class="row.text">
        <span>{{ row.word }}</span>
        <span class="status-dot" :class="row.dot"></span>
      </div>
    </div>
    <div v-if="staleMinutes != null" class="mt-2 text-xs text-warn">
      Vue datée de {{ staleMinutes }} min — hub injoignable ?
    </div>
  </template>
</template>
