<script setup lang="ts">
import type { ControlRoom } from '@conference-operator/contract'
import { Button, Panel, StatusDot } from '@conference-operator/components'
import { appearanceOf } from '@conference-operator/room-state'
import { timeAgo } from '@conference-operator/format'
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useGatewayStore } from '../stores/gateway.js'
import { useSessionStore } from '../stores/session.js'
import { useLockStore } from '../stores/lock.js'

/**
 * Choosing a room, and knowing whether it is free.
 *
 * Cards and not a table: the mobile control app is used standing up, at the back
 * of a room or in a corridor, and six columns become unreadable there. The same
 * reasoning as the console's Exploitation tab, in a format never wider than a
 * thumb.
 *
 * Each card carries the two things that decide: **where the room stands** — the
 * word, not only the tint — and **who holds it**, if anybody does.
 */
const gateway = useGatewayStore()
const session = useSessionStore()
const lock = useLockStore()

/** Refreshed at the console supervision's pace: nothing is driven here. */
const REFRESH_MS = 10_000
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  void lock.load()
  timer = setInterval(() => void lock.load(), REFRESH_MS)
})

onBeforeUnmount(() => {
  if (timer != null) clearInterval(timer)
})

/**
 * The boot payload's rooms while waiting for the hub's.
 *
 * The names are laid down in the shell, so they can be shown before any response:
 * an empty list for the duration of a round trip reads as a hub with no program.
 * They have neither state nor lock until the first call has answered, and the
 * cards say so by staying neutral rather than asserting "hors créneau".
 */
const rooms = computed<ControlRoom[]>(() =>
  lock.rooms.length > 0
    ? lock.rooms
    : gateway.boot.salles.map((room) => ({
        roomId: room.id,
        name: room.name,
        conference: 'aucune' as const,
        connectivity: 'OFFLINE' as const,
        lock: null,
      })),
)

const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 1_000)
})
onBeforeUnmount(() => {
  if (clock != null) clearInterval(clock)
})

/** The holder, or `null`: that word is what decides whether to take over. */
function heldBy(room: ControlRoom): string | null {
  return room.lock?.holder ?? null
}

/**
 * Held by **my account**, which does not mean by this tab.
 *
 * The list cannot decide any more finely: it serves to choose where to go, and
 * the room's veil will then say whether it is this tab or another of your
 * devices. Writing "you hold it" here would lie half the time.
 */
function mine(room: ControlRoom): boolean {
  return heldBy(room) != null && heldBy(room) === session.identity
}

/**
 * Entering, without taking.
 *
 * A single decision, in a single place: the room's veil. Taking from this list
 * forced a decision on the strength of one line — "nuit@… holds Track #1" —
 * without seeing what is happening there, when that is exactly what one wants to
 * look at before removing somebody's controls.
 *
 * The price is one more round trip for the free room, the most common case. It is
 * small: the veil opens already filled in, and its button is the first one under
 * the thumb.
 */
function open(room: ControlRoom): void {
  lock.watch(room.roomId)
}
</script>

<template>
  <main class="mx-auto w-full max-w-[560px] p-3">
    <h1 class="mb-1 text-base font-semibold">Régie mobile</h1>
    <p class="mb-3 text-xs text-dim">
      Choisissez une salle. Une seule régie mobile la pilote à la fois — celle de
      la salle, elle, garde toujours la main.
    </p>

    <div class="flex flex-col gap-2">
      <Panel v-for="room in rooms" :key="room.roomId">
        <button
          class="flex w-full items-start gap-2.5 text-left"
          :data-room="room.roomId"
          @click="open(room)"
        >
          <StatusDot
            class="mt-1 shrink-0"
            :state="room.conference"
            :connectivity="room.connectivity"
          />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm">{{ room.name }}</span>
            <span class="block text-xs" :class="appearanceOf(room.conference).text">
              {{ appearanceOf(room.conference).word }}
            </span>
            <!--
              The holder, named, and since when. "Occupée" on its own would send
              people looking for who: the answer is two rooms away, and that is the
              round trip being avoided.
            -->
            <span v-if="heldBy(room) != null" class="mt-0.5 block text-xs text-warn">
              <template v-if="mine(room)">
                Tenue par votre compte · depuis {{ timeAgo(room.lock!.heldSince, now) }}
              </template>
              <template v-else>
                {{ heldBy(room) }} · depuis
                {{ timeAgo(room.lock!.heldSince, now) }}
              </template>
            </span>
          </span>
          <span class="shrink-0 self-center text-xs text-dim" aria-hidden="true">›</span>
        </button>
      </Panel>
    </div>

    <div class="mt-4 flex items-center justify-between text-xs text-dim">
      <span>{{ session.identity ?? 'Connecté' }}</span>
      <Button @click="session.signOut()">Se déconnecter</Button>
    </div>

  </main>
</template>
