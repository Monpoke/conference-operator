<script setup lang="ts">
import { Button } from '@cloudnord/components'
import { timeAgo } from '@cloudnord/format'
import { useSessionStore } from '../stores/session.js'
import { useLockStore } from '../stores/lock.js'

/**
 * Where one is, and under which account. Nothing more.
 *
 * Taking over is **not here**. It lived in this banner for a while, as a button
 * beside the holder's name, and that was the mistake: the page stayed entirely on
 * screen, every command left for the hub only to be refused, and the small line
 * was only read after pressing. A room one does not hold is not a banner detail,
 * it is a state — it lives in `LockVeil`.
 *
 * What is left is what serves whatever the state: getting back to the rooms, and
 * knowing which account one is signed in under — the very question one asks on
 * discovering that another tab holds the room.
 */
const props = defineProps<{ nowMs: number }>()

const session = useSessionStore()
const lock = useLockStore()
</script>

<template>
  <div
    class="flex items-center gap-2 border-b border-edge bg-surface px-3 py-2 text-xs"
    data-role="lock"
  >
    <Button class="shrink-0" @click="lock.leave()">‹ Salles</Button>

    <span v-if="lock.iHold" class="min-w-0 flex-1 truncate text-dim">
      Vous pilotez cette salle
      <span v-if="lock.lock != null">
        · depuis {{ timeAgo(lock.lock.heldSince, props.nowMs) }}
      </span>
    </span>

    <!--
      Held elsewhere: the veil says so in large type and carries the decision.
      Here, a mention, so the line does not contradict itself when the veil closes.
    -->
    <span
      v-else-if="lock.heldElsewhere"
      class="min-w-0 flex-1 truncate text-warn"
      data-role="lock-holder"
    >
      Lecture seule — {{ lock.myOtherSession ? 'un autre de vos onglets' : lock.holder }}
    </span>

    <span v-else class="min-w-0 flex-1 truncate text-dim">Salle non prise</span>

    <span class="shrink-0 text-dim">{{ session.identity ?? '' }}</span>
  </div>
</template>
