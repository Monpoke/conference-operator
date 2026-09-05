import { PAIRING_ALIAS, viewPath } from '@conference-operator/contract'
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import ConferencesView from './views/ConferencesView.vue'
import OperationsView from './views/OperationsView.vue'
import MessagesView from './views/MessagesView.vue'
import PairingView from './views/PairingView.vue'
import SettingsView from './views/SettingsView.vue'
import VodView from './views/VodView.vue'
import ModerationView from './views/ModerationView.vue'
import { useConferencesStore } from './stores/conferences.js'
import { useOperationsStore } from './stores/operations.js'
import { useMessagesStore } from './stores/messages.js'
import { usePairingStore } from './stores/pairing.js'
import { useSettingsStore } from './stores/settings.js'
import { useVodStore } from './stores/vod.js'
import { useModerationStore } from './stores/moderation.js'

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
  {
    path: viewPath('messages'),
    name: 'messages',
    component: MessagesView,
    meta: {
      view: 'messages',
      refresh: () => useMessagesStore().load(),
      intervalMs: 10_000,
    },
  },
  {
    path: viewPath('appairage'),
    /*
     * An **alias**, never a redirect.
     *
     * `/admin/devices?user_code=…` is the address Better Auth gives the machines.
     * Rewriting the URL to `/admin/appairage` would erase the code the operator is
     * about to approve — on load, that is, at the one moment anybody needs it.
     */
    alias: PAIRING_ALIAS,
    name: 'appairage',
    component: PairingView,
    meta: {
      view: 'appairage',
      refresh: () => usePairingStore().load(),
      intervalMs: 10_000,
    },
  },
  {
    path: viewPath('vod'),
    name: 'vod',
    component: VodView,
    meta: { view: 'vod', refresh: () => useVodStore().load(), intervalMs: 10_000 },
  },
  {
    path: viewPath('conferences'),
    name: 'conferences',
    component: ConferencesView,
    meta: { view: 'conferences', refresh: () => useConferencesStore().load(), intervalMs: 10_000 },
  },
  {
    path: viewPath('reglages'),
    name: 'reglages',
    component: SettingsView,
    meta: { view: 'reglages', refresh: () => useSettingsStore().load(), intervalMs: 10_000 },
  },
  {
    path: viewPath('exploitation'),
    name: 'exploitation',
    component: OperationsView,
    meta: { view: 'exploitation', refresh: () => useOperationsStore().load(), intervalMs: 10_000 },
  },
  {
    path: viewPath('developpement'),
    name: 'developpement',
    /*
     * Imported on demand, and it is a lock, not an optimisation.
     *
     * `consoleViews(dev)` already stops the hub serving this address in production.
     * But a static `import` would bring the code that moves the whole system's
     * clock — and the one that erases the footage — into the bundle served on the
     * day, one `fetch` away from whoever inspects the page.
     */
    component: () => import('./views/DevelopmentView.vue'),
    meta: {
      view: 'developpement',
      refresh: async () => {
        /*
         * The schedule, in addition to the clock.
         *
         * The view draws two things from it, and it was not loading it: the
         * shortcuts to the program's moments — deduced from the slots, so absent
         * when the schedule is — and the time zone the hub's clock is displayed in.
         * Without it, that time reads in the time zone of the machine one is looking
         * from, which is precisely the mistake this setting exists to flush out.
         *
         * None of this was visible when arriving from the Conférences tab, which had
         * loaded it along the way: the buttons appeared or not depending on the path
         * taken.
         *
         * Loaded once, if it is missing: the program does not move while the clock
         * is being pushed, and re-reading it every ten seconds would make three
         * calls for an identical answer.
         */
        const conferences = useConferencesStore()
        if (conferences.planning == null) await conferences.load()

        const { useDevStore } = await import('./stores/dev.js')
        await useDevStore().load()
      },
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

