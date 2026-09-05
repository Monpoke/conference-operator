<script setup lang="ts">
import type { DisplayPayload } from '@conference-operator/contract'
import { computed } from 'vue'
import { otherRooms, stripEntry } from '../lib/rooms.js'
import { useProgramsStore } from '../stores/programs.js'

/**
 * One line, always visible: what decides a schedule shift.
 *
 * "The other room finishes in 3 minutes, we do not start the talk now." It is the
 * day's only piece of information an operator cannot deduce from their own
 * screen, and it must be readable without opening anything. The detail — a room's
 * full program — is one click away, in a modal.
 */
const props = defineProps<{ payload: DisplayPayload; nowMs: number }>()

const emit = defineEmits<{ open: [roomId: string] }>()

const programs = useProgramsStore()

const entries = computed(() =>
  otherRooms(props.payload, programs.rooms).map((room) =>
    stripEntry(props.payload, room, programs.sessions[room.id] ?? [], props.nowMs),
  ),
)
</script>

<template>
  <!-- Disappears entirely when there is nothing: an empty strip takes up a line
       on a control screen that has none to spare. -->
  <div
    v-if="entries.length > 0"
    class="flex items-center gap-1.5 overflow-x-auto border-b border-edge bg-surface px-3 py-1.5"
    data-role="rooms-strip"
  >
    <button
      v-for="entry in entries"
      :key="entry.id"
      type="button"
      class="flex shrink-0 cursor-pointer items-center gap-2 rounded-md border border-edge bg-surface2 px-2.5 py-1 text-xs font-normal"
      :data-room="entry.id"
      @click="emit('open', entry.id)"
    >
      <!--
        A bare dot, and not `StatusDot`: the latter decides its fill from a talk
        state, whereas `roomState` has already decided — it knows a case the
        appearance table does not, the room whose program we do not have. Handing
        it a ready-made class would be a third use its props do not describe.
      -->
      <span class="status-dot" :class="entry.dot"></span>
      <span class="font-semibold">{{ entry.name }}</span>
      <span
        v-if="entry.breakTag != null"
        class="shrink-0 rounded bg-canvas px-1.5 py-0.5 text-[11px]"
        :class="entry.breakTag.tint"
      >
        {{ entry.breakTag.text }}
      </span>
      <span v-if="entry.label !== ''" class="max-w-[26ch] truncate text-dim">
        {{ entry.label }}
      </span>
      <span class="tabular-nums" :class="entry.tint">{{ entry.detail }}</span>
    </button>
  </div>
</template>
