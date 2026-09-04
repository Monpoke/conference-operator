<script setup lang="ts">
import { viewPath } from '@cloudnord/contract'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { useNotificationsStore } from '../stores/notifications.js'

/**
 * The notices, at the bottom of the console.
 *
 * Solid background and dark text: these cards must be readable out of the corner
 * of the eye, and that is the only pairing readable on amber — the one the
 * console's active button already uses.
 *
 * Clickable, as the system notification is: a card saying "Track #2 déborde"
 * without leading there leaves one searching.
 */
const store = useNotificationsStore()
const { alerts } = storeToRefs(store)
const router = useRouter()

const TINTS = {
  essentiel: 'bg-warn text-[#05070d]',
  tout: 'bg-brand text-[#05070d]',
  rien: 'bg-brand text-[#05070d]',
} as const

function go(view: string | null): void {
  if (view == null) return
  void router.push(viewPath(view))
}
</script>

<template>
  <div
    id="alerts"
    class="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex flex-col items-center gap-2"
  >
    <div
      v-for="alert in alerts"
      :key="alert.key"
      class="pointer-events-auto flex max-w-[min(560px,90vw)] shrink-0 items-start gap-2.5 rounded-lg px-3.5 py-2 text-[13px] shadow-[0_10px_30px_rgba(0,0,0,.45)]"
      :class="[TINTS[alert.scope], alert.view != null ? 'cursor-pointer' : '']"
      :data-alert="alert.key"
      @click="go(alert.view)"
    >
      <div class="min-w-0 flex-1">
        <div class="font-semibold">{{ alert.title }}</div>
        <div v-if="alert.body !== ''" class="opacity-75">{{ alert.body }}</div>
      </div>
      <button
        class="cursor-pointer border-0 bg-transparent px-1.5 py-0.5 text-current opacity-60"
        aria-label="Fermer"
        @click.stop="store.dismiss(alert.key)"
      >
        ×
      </button>
    </div>
  </div>
</template>
