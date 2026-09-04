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

const TEINTES = {
  essentiel: 'bg-warn text-[#05070d]',
  tout: 'bg-brand text-[#05070d]',
  rien: 'bg-brand text-[#05070d]',
} as const

function aller(vue: string | null): void {
  if (vue == null) return
  void router.push(viewPath(vue))
}
</script>

<template>
  <div
    id="signalements"
    class="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex flex-col items-center gap-2"
  >
    <div
      v-for="alerte in alerts"
      :key="alerte.key"
      class="pointer-events-auto flex max-w-[min(560px,90vw)] shrink-0 items-start gap-2.5 rounded-lg px-3.5 py-2 text-[13px] shadow-[0_10px_30px_rgba(0,0,0,.45)]"
      :class="[TEINTES[alerte.scope], alerte.view != null ? 'cursor-pointer' : '']"
      :data-alert="alerte.key"
      @click="aller(alerte.view)"
    >
      <div class="min-w-0 flex-1">
        <div class="font-semibold">{{ alerte.title }}</div>
        <div v-if="alerte.body !== ''" class="opacity-75">{{ alerte.body }}</div>
      </div>
      <button
        class="cursor-pointer border-0 bg-transparent px-1.5 py-0.5 text-current opacity-60"
        aria-label="Fermer"
        @click.stop="store.dismiss(alerte.key)"
      >
        ×
      </button>
    </div>
  </div>
</template>
