import { isMigratedView, viewPath } from '@cloudnord/contract'
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import ModerationView from './views/ModerationView.vue'
import { useModerationStore } from './stores/moderation.js'

/**
 * Which views belong to this bundle is decided in the contract.
 *
 * Both sides need the same answer and neither can own it: the hub reads it to
 * pick a handler, this router reads it to pick between a route and a plain
 * link. Re-exported here so components have one import to reach for.
 *
 * The cost of the boundary is a full page load when crossing it. It is real,
 * and it is visible — which is the point: nobody forgets a migration that
 * reloads.
 */
export const isMigrated = isMigratedView

declare module 'vue-router' {
  interface RouteMeta {
    /** The view's name, as `consoleViews()` spells it. */
    view?: string
    /**
     * How this route refreshes itself.
     *
     * Declared here rather than in a switch inside a global `tout()`, which is
     * what the page did: a view added without its branch simply never
     * refreshed, and nothing said so.
     */
    refresh?: () => Promise<void>
    intervalMs?: number
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: viewPath('moderation'),
    name: 'moderation',
    component: ModerationView,
    meta: {
      view: 'moderation',
      refresh: () => useModerationStore().load(),
      intervalMs: 10_000,
    },
  },
  /*
   * Anything not migrated is not a route: it is another page.
   *
   * Answering it with a component would render an empty console at an address
   * the hub serves properly. A hard navigation is the honest answer, and it is
   * what a bookmark or a shared link does anyway.
   */
  {
    path: '/admin/:pathMatch(.*)*',
    name: 'elsewhere',
    beforeEnter: (to) => {
      globalThis.location.assign(to.fullPath)
      return false
    },
    component: ModerationView,
  },
]

export function createConsoleRouter(): ReturnType<typeof createRouter> {
  return createRouter({ history: createWebHistory(), routes })
}

