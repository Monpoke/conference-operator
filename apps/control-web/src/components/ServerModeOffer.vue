<script setup lang="ts">
import { Button } from '@conference-operator/components'
import { ref, watch } from 'vue'
import { useActionsStore } from '../stores/actions.js'

/**
 * The offer to step aside when an OBS dock drives the room.
 *
 * The machine's window then renders the whole control app for nobody: the dock
 * does the steering, a few centimetres from OBS. Server mode swaps this page for
 * one that renders next to nothing — the room keeps running behind it, and a
 * button brings the console back.
 *
 * Offered, never imposed: the window does not change under the operator's eyes
 * because a dock was opened elsewhere. Declining holds for the tab (a reload
 * does not ask again), and so does coming back from server mode by its button —
 * `?console` — or the offer would follow straight on the way back. A dock that
 * leaves resets it: the next dock is a new question.
 */
const props = defineProps<{ dockConnected: boolean; dockActedAt?: number | null }>()

const DISMISSED = 'regie.mode-serveur.ecarte'

function readDismissed(): boolean {
  if (new URLSearchParams(globalThis.location.search).has('console')) return true
  try {
    return globalThis.sessionStorage.getItem(DISMISSED) === '1'
  } catch {
    return false
  }
}

function writeDismissed(value: boolean): void {
  try {
    if (value) globalThis.sessionStorage.setItem(DISMISSED, '1')
    else globalThis.sessionStorage.removeItem(DISMISSED)
  } catch {
    // Storage refused: the offer simply comes back at the next reload.
  }
}

const dismissed = ref(readDismissed())

/**
 * Server mode by itself, once the dock acts.
 *
 * A dock that sends gestures is a dock in use, and this window then renders for
 * nobody. Three things hold it on the console all the same:
 * - the operator declined, or came back from server mode by its button;
 * - **this window was used** — a gesture made here since the dock arrived: two
 *   people may well drive together, and the window must not vanish under a hand;
 * - the dock's gesture predates this page: coming back to the console must not
 *   bounce straight back out on an old one.
 */
const actions = useActionsStore()
let ownGesturesAtReset = actions.gestures
const seenAtLoad = props.dockActedAt ?? null

watch(
  () => props.dockActedAt ?? null,
  (actedAt) => {
    if (actedAt == null || actedAt === seenAtLoad) return
    if (dismissed.value || actions.gestures !== ownGesturesAtReset) return
    enter()
  },
)

watch(
  () => props.dockConnected,
  (connected) => {
    if (connected) return
    dismissed.value = false
    writeDismissed(false)
    // The next dock is a new question, for the automatic switch too.
    ownGesturesAtReset = actions.gestures
  },
)

function dismiss(): void {
  dismissed.value = true
  writeDismissed(true)
}

function enter(): void {
  globalThis.location.assign('/regie/serveur')
}
</script>

<template>
  <div
    v-if="props.dockConnected && !dismissed"
    class="flex items-center gap-2 border-b border-edge bg-surface px-3 py-2 text-xs"
    data-role="server-mode-offer"
  >
    <span class="min-w-0 flex-1 truncate text-text">
      Un dock OBS pilote cette salle. Cette fenêtre peut passer en mode serveur&nbsp;: la salle
      continue de tourner, sans afficher la console.
    </span>
    <Button size="small" class="shrink-0" data-role="btn-stay" @click="dismiss()">
      Rester sur la console
    </Button>
    <Button
      size="small"
      variant="primary"
      class="shrink-0"
      data-role="btn-server-mode"
      @click="enter()"
    >
      Passer en mode serveur
    </Button>
  </div>
</template>
