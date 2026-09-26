<script setup lang="ts">
import type { DisplayPayload } from '@conference-operator/contract'
import type { Session } from '@conference-operator/program'
import { Button, Dialog } from '@conference-operator/components'
import { time } from '@conference-operator/format'
import { computed } from 'vue'
import { useActionsStore } from '../stores/actions.js'
import { useKeyboardLayer } from '../stores/keyboard.js'
import { useTalkStore } from '../stores/talk.js'

/**
 * The emergency list: the room's talks, to force one or swap two.
 *
 * A speaker stuck in a train, the next one plugged in and ready: the room has to
 * show the talk that is really about to be given, not the one the clock expects.
 * Two ways out, and they do not mean the same thing:
 *
 *  - **Forcer maintenant** changes only what the room shows. The programme is
 *    untouched, and "Libérer" gives the room back to the clock.
 *  - **Échanger** rewrites the programme: the two slots trade places, for the
 *    agenda, the other rooms and the hub's history alike.
 *
 * Ended talks are left out: forcing one back would replay a talk already held,
 * and the hub would refuse to swap it anyway.
 */
const props = defineProps<{ payload: DisplayPayload }>()

const talk = useTalkStore()
const actions = useActionsStore()

/*
 * An empty layer: the page's shortcuts act on the talk and the projection, and
 * the list is read with the fingers still on the keyboard.
 */
useKeyboardLayer(() => ({}), () => talk.forceOpen)

const target = computed(() => props.payload.state.targetSession)
const pinned = computed(() => props.payload.state.pinnedSessionId ?? null)

const statusOf = (id: string) => props.payload.state.sessionStates?.[id] ?? 'scheduled'

const rows = computed(() =>
  (props.payload.sessions ?? []).filter(
    (slot) => slot.kind === 'talk' && statusOf(slot.id) !== 'ended',
  ),
)

const speakers = (slot: Session) => slot.speakers.map((person) => person.name).join(' · ')

/**
 * Swapping only between two talks that have not begun: the hub refuses it
 * otherwise, and a button that can only fail has no business being offered.
 */
function canSwap(slot: Session): boolean {
  const aimed = target.value
  if (aimed == null || aimed.id === slot.id) return false
  return statusOf(aimed.id) === 'scheduled' && statusOf(slot.id) === 'scheduled'
}

/** Closes on success only: a refusal leaves the list open, with its notice. */
async function force(id: string): Promise<void> {
  if ((await talk.pin(id)).ok) talk.forceOpen = false
}

async function exchange(id: string): Promise<void> {
  const aimed = target.value
  if (aimed == null) return
  if ((await talk.swap(aimed.id, id)).ok) talk.forceOpen = false
}
</script>

<template>
  <Dialog
    v-model:open="talk.forceOpen"
    title="Forcer un talk"
    description="Forcer change ce que la salle affiche, sans toucher au programme. Échanger inverse deux créneaux dans le programme."
    width="wide"
  >
    <div v-if="rows.length === 0" class="text-sm text-dim" data-role="force-empty">
      Plus aucun talk à venir dans cette salle.
    </div>
    <ul v-else class="flex flex-col divide-y divide-edge">
      <li
        v-for="slot in rows"
        :key="slot.id"
        class="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center"
        data-role="force-row"
        :data-session="slot.id"
      >
        <div class="min-w-0 flex-1">
          <div class="text-sm leading-snug">
            <span class="text-dim tabular-nums">{{ time(slot.startsAt, payload.timezone) }}</span>
            · {{ slot.title }}
            <span v-if="slot.id === pinned" class="ml-1 text-xs font-semibold text-warn uppercase">forcée</span>
            <span v-else-if="slot.id === target?.id" class="ml-1 text-xs text-dim">(en salle)</span>
            <span v-if="statusOf(slot.id) === 'running'" class="ml-1 text-xs text-ok">en cours</span>
          </div>
          <div v-if="speakers(slot) !== ''" class="mt-0.5 line-clamp-1 text-xs text-dim">
            {{ speakers(slot) }}
          </div>
        </div>
        <div class="flex shrink-0 flex-wrap gap-1.5">
          <Button
            v-if="slot.id !== pinned"
            size="small"
            data-role="force-pin"
            :disabled="actions.pending > 0"
            @click="force(slot.id)"
          >
            Forcer maintenant
          </Button>
          <Button
            v-if="canSwap(slot)"
            size="small"
            class="max-w-[260px] truncate"
            data-role="force-swap"
            :title="`Échanger avec « ${target?.title} »`"
            :disabled="actions.pending > 0"
            @click="exchange(slot.id)"
          >
            Échanger avec « {{ target?.title }} »
          </Button>
        </div>
      </li>
    </ul>
  </Dialog>
</template>
