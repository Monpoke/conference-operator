<script setup lang="ts">
import { consoleViews, viewPath } from '@cloudnord/contract'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { isMigrated } from '../router.js'
import { useSessionStore } from '../stores/session.js'

/**
 * The tabs.
 *
 * Routes, not a tab component: these are shareable addresses that survive a
 * reload and sit in a bookmark. Reka's `Tabs` would put a component's internal
 * state in front of the browser's history, and they would argue.
 *
 * Views the bundle has not taken over yet get a plain link, so the browser
 * loads the page the hub still serves for them.
 */
const session = useSessionStore()
const route = useRoute()

const views = computed(() =>
  consoleViews(session.dev).map((view) => ({
    view,
    path: viewPath(view),
    migrated: isMigrated(view),
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
    <template v-for="entry in views" :key="entry.view">
      <RouterLink
        v-if="entry.migrated"
        :id="`nav-${entry.view}`"
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
      <a
        v-else
        :id="`nav-${entry.view}`"
        :href="entry.path"
        class="rounded-lg border border-transparent bg-transparent px-3 py-2 text-[13px] text-attenue"
      >
        {{ entry.label }}
      </a>
    </template>
  </nav>
</template>
