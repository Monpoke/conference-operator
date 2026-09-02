<script setup lang="ts">
import { consoleViews, viewPath } from '@cloudnord/contract'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useSessionStore } from '../stores/session.js'

/**
 * The tabs.
 *
 * Routes, not a tab component: these are shareable addresses that survive a
 * reload and sit in a bookmark. Reka's `Tabs` would put a component's internal
 * state in front of the browser's history, and they would argue.
 */
const session = useSessionStore()
const route = useRoute()

const views = computed(() =>
  consoleViews(session.dev).map((view) => ({
    view,
    path: viewPath(view),
    label: LABELS[view] ?? view,
  })),
)

const LABELS: Record<string, string> = {
  exploitation: 'Exploitation',
  appairage: 'Appairage',
  conferences: 'Conférences',
  moderation: 'Modération',
  messages: 'Messages',
  vod: 'VOD',
  reglages: 'Réglages',
  developpement: 'Développement',
}

function current(view: string): boolean {
  return route.meta.view === view
}
</script>

<template>
  <nav class="flex flex-wrap gap-1.5 border-b border-bord px-4 pb-3">
    <RouterLink
      v-for="entry in views"
      :id="`nav-${entry.view}`"
      :key="entry.view"
      :to="entry.path"
      class="rounded-lg border px-3 py-2 text-[13px]"
      :class="
        current(entry.view)
          ? 'border-bord bg-surface2 text-texte'
          : 'border-transparent bg-transparent text-attenue'
      "
      :aria-current="current(entry.view) ? 'page' : undefined"
    >
      {{ entry.label }}
    </RouterLink>
  </nav>
</template>
