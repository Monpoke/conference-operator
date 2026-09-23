<script setup lang="ts">
import { VIEW_PERMISSIONS, consoleViews, viewPath } from '@conference-operator/contract'
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

// Only the tabs the operator's groups open: a tab that answers with errors
// reads as a broken console, not as a missing right.
const views = computed(() =>
  consoleViews(session.dev)
    .filter((view) => VIEW_PERMISSIONS[view] != null && session.can(VIEW_PERMISSIONS[view]))
    .map((view) => ({
      view,
      path: viewPath(view),
      label: LABELS[view] ?? view,
    })),
)

const LABELS: Record<string, string> = {
  acces: 'Accès',
  exploitation: 'Exploitation',
  appairage: 'Appairage',
  conferences: 'Conférences',
  moderation: 'Modération',
  messages: 'Messages',
  vod: 'VOD',
  boucle: 'Boucle',
  reglages: 'Réglages',
  developpement: 'Développement',
}

function current(view: string): boolean {
  return route.meta.view === view
}
</script>

<template>
  <nav class="flex flex-wrap gap-1.5 border-b border-edge px-4 pb-3">
    <RouterLink
      v-for="entry in views"
      :id="`nav-${entry.view}`"
      :key="entry.view"
      :to="entry.path"
      class="rounded-lg border px-3 py-2 text-[13px]"
      :class="
        current(entry.view)
          ? 'border-edge bg-surface2 text-text'
          : 'border-transparent bg-transparent text-dim'
      "
      :aria-current="current(entry.view) ? 'page' : undefined"
    >
      {{ entry.label }}
    </RouterLink>
  </nav>
</template>
