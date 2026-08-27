import { PAIRING_ALIAS, isMigratedView, viewPath } from '@cloudnord/contract'
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
     * Un **alias**, jamais une redirection.
     *
     * `/admin/devices?user_code=…` est l'adresse que Better Auth donne aux
     * machines. Réécrire l'URL vers `/admin/appairage` effacerait le code que
     * l'opérateur s'apprête à approuver — au chargement, c'est-à-dire au seul
     * moment où quelqu'un en a besoin.
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
     * Importé à la demande, et c'est un verrou, pas une optimisation.
     *
     * `consoleViews(dev)` empêche déjà le hub de servir cette adresse en
     * production. Mais un `import` statique ferait entrer le code qui déplace
     * l'heure de tout le système — et celui qui efface les rushes — dans le
     * bundle servi le jour J, à un `fetch` de distance de qui inspecte la page.
     */
    component: () => import('./views/DevelopmentView.vue'),
    meta: {
      view: 'developpement',
      refresh: async () => {
        /*
         * Le planning, en plus de l'horloge.
         *
         * La vue en tire deux choses, et elle ne le chargeait pas : les
         * raccourcis vers les moments du programme — déduits des créneaux, donc
         * absents quand le planning l'est — et le fuseau dans lequel l'heure du
         * hub s'affiche. Sans lui, cette heure se lit dans le fuseau du poste
         * d'où l'on regarde, ce qui est précisément l'erreur que ce réglage
         * sert à débusquer.
         *
         * On ne voyait rien de tout ça en venant de l'onglet Conférences, qui
         * l'avait chargé au passage : les boutons apparaissaient ou non selon
         * le chemin emprunté.
         *
         * Chargé une seule fois, s'il manque : le programme ne bouge pas
         * pendant qu'on pousse l'horloge, et le relire toutes les dix secondes
         * ferait trois appels pour une réponse identique.
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

