<script setup lang="ts">
import type { DisplayPayload } from '@cloudnord/contract'
import { computed } from 'vue'
import { otherRooms, stripEntry } from '../lib/rooms.js'
import { useProgramsStore } from '../stores/programs.js'

/**
 * Une ligne, toujours visible : ce qui décide d'un décalage.
 *
 * « L'autre salle finit dans 3 minutes, on ne lance pas le talk maintenant. »
 * C'est la seule information de la journée qu'un opérateur ne peut pas déduire
 * de son propre écran, et elle doit se lire sans ouvrir quoi que ce soit. Le
 * détail — le programme complet d'une salle — est à un clic, en modale.
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
  <!-- Disparaît complètement quand il n'y a rien : une bande vide occupe une
       ligne d'un écran de régie qui n'en a pas de trop. -->
  <div
    v-if="entries.length > 0"
    class="flex items-center gap-1.5 overflow-x-auto border-b border-bord bg-surface px-3 py-1.5"
    data-role="rooms-strip"
  >
    <button
      v-for="entry in entries"
      :key="entry.id"
      type="button"
      class="flex shrink-0 cursor-pointer items-center gap-2 rounded-md border border-bord bg-surface2 px-2.5 py-1 text-xs font-normal"
      :data-salle="entry.id"
      @click="emit('open', entry.id)"
    >
      <!--
        Une pastille nue, et non `StatusDot` : celui-ci décide le remplissage à
        partir d'un état de conférence, or `roomState` a déjà tranché — il
        connaît un cas que la table des apparences n'a pas, la salle dont on n'a
        pas le programme. Lui repasser une classe toute faite serait un
        troisième usage que ses props ne décrivent pas.
      -->
      <span class="pastille" :class="entry.dot"></span>
      <span class="font-semibold">{{ entry.name }}</span>
      <span
        v-if="entry.breakTag != null"
        class="shrink-0 rounded bg-fond px-1.5 py-0.5 text-[11px]"
        :class="entry.breakTag.tint"
      >
        {{ entry.breakTag.text }}
      </span>
      <span v-if="entry.label !== ''" class="max-w-[26ch] truncate text-attenue">
        {{ entry.label }}
      </span>
      <span class="tabular-nums" :class="entry.tint">{{ entry.detail }}</span>
    </button>
  </div>
</template>
