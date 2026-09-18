<script setup lang="ts">
import { Badge, Button, Toaster } from '@conference-operator/components'
import { storeToRefs } from 'pinia'
import { CONTROL_PATH, VIEW_PERMISSIONS, consoleViews, viewPath } from '@conference-operator/contract'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AlertStack from './components/AlertStack.vue'
import ConsoleNav from './components/ConsoleNav.vue'
import NotificationsDialog from './components/NotificationsDialog.vue'
import SignInScreen from './components/SignInScreen.vue'
import { useNotificationsStore } from './stores/notifications.js'
import { useSessionStore } from './stores/session.js'

/**
 * The console's shell, and its refresh loop.
 *
 * A single loop reading `route.meta.refresh` replaces a thirty-line `if/else if`
 * that had to be extended by hand for every view — and where forgetting a branch
 * meant the view simply never refreshed, in silence. Two things fall out for free:
 * a hidden tab stops polling, and a view loads at once instead of waiting for the
 * next round.
 */
const session = useSessionStore()
const notifications = useNotificationsStore()
const { signedIn, eventName, mode, identity, permissions, version } = storeToRefs(session)

/**
 * The hub's version, behind a click on the title.
 *
 * Useful when reporting a problem, useless the rest of the day: it has no place
 * in a header read at a glance.
 */
const versionShown = ref(false)
const { supported, on } = storeToRefs(notifications)
const route = useRoute()
const router = useRouter()

/** A view without a declared right is not a console view: nothing to guard. */
function opens(view: string | undefined): boolean {
  if (view == null) return true
  const required = VIEW_PERMISSIONS[view]
  return required != null && session.can(required)
}

const firstOpen = computed(() => consoleViews(session.dev).find((view) => opens(view)) ?? null)
const current = computed(() => permissions.value != null && opens(route.meta.view))

/**
 * Leave a view the operator's groups do not open.
 *
 * Towards the first one they do — a bookmark on Réglages opened by a moderator
 * lands on Modération rather than on a page of refusals.
 */
watch(
  [() => route.fullPath, permissions],
  () => {
    if (permissions.value == null || opens(route.meta.view)) return
    if (firstOpen.value != null) void router.replace(viewPath(firstOpen.value))
  },
  { immediate: true },
)

const notifSettingsOpen = ref(false)
const timer = ref<ReturnType<typeof setTimeout> | null>(null)

function stop(): void {
  if (timer.value != null) clearTimeout(timer.value)
  timer.value = null
}

/**
 * A chained `setTimeout`, and not `setInterval`.
 *
 * The interval counts from the **end** of the request. With `setInterval`, a hub
 * answering more slowly than the period piled the calls on top of one another —
 * that is, precisely when it could least afford it.
 */
async function tick(): Promise<void> {
  const { refresh, intervalMs } = route.meta
  // Not before the hub has said what the operator may open: polling a view
  // about to be left would only raise refusals.
  if (refresh == null || !signedIn.value || !current.value) return
  if (document.visibilityState === 'visible') {
    try {
      await refresh()
    } catch {
      // Already reported by the client's error hook.
    }
  }
  stop()
  timer.value = setTimeout(() => void tick(), intervalMs ?? 10_000)
}

watch(
  [() => route.fullPath, signedIn, current],
  () => {
    stop()
    void tick()
  },
  { immediate: true },
)

/**
 * The title follows the event's name.
 *
 * Renaming the event and going on reading the old name at the top of one's own
 * console would be the first place to doubt the setting had been taken.
 */
watch(
  eventName,
  (name) => {
    if (name !== '') document.title = `${name} — console hub`
  },
  { immediate: true },
)

onScopeDispose(stop)

function refresh(): void {
  void route.meta.refresh?.()
}
</script>

<template>
  <SignInScreen v-if="!signedIn" />

  <div v-else id="console" class="mx-auto min-h-dvh max-w-[1180px] p-3 sm:p-5">
    <header class="flex flex-wrap items-center gap-3 pb-3">
      <h1
        id="console-title"
        class="cursor-default text-[17px] font-semibold select-none sm:text-[19px]"
        :title="version == null ? undefined : `Version ${version}`"
        @click="versionShown = !versionShown"
      >
        {{ eventName }} — console hub
      </h1>
      <span v-if="versionShown && version != null" id="version" class="text-[12px] text-dim">
        v{{ version }}
      </span>
      <Badge v-if="mode !== 'production'" id="badge-mode" variant="warning">{{ mode }}</Badge>
      <!--
        Qui est connecté, quand le hub le dit. Le retour de Google ne laisse
        aucun jeton derrière lui : c'est la seule confirmation qu'on a bien
        atterri avec le bon compte.
      -->
      <div v-if="identity != null" id="identity" class="hidden text-[13px] text-dim sm:block">
        {{ identity }}
      </div>
      <div class="ml-auto flex gap-1.5">
        <!--
          Un lien et non un bouton : la régie mobile est une autre application,
          servie par le même hub. Masqué pour qui n'a pas le droit de l'ouvrir,
          elle ne lui montrerait qu'un refus.
        -->
        <a
          v-if="session.can('regie:view')"
          id="btn-regie"
          :href="CONTROL_PATH"
          class="rounded-lg border border-edge bg-surface2 px-3 py-2 text-[13px] font-semibold text-text transition-colors hover:border-brand hover:bg-edge"
        >
          Régie mobile
        </a>
        <!--
          Le bouton n'apparaît que si le navigateur sait notifier. Le point
          signale que cet appareil-ci est réglé — une permission accordée
          ailleurs ne suffit pas.
        -->
        <Button
          v-if="supported"
          id="btn-notifs"
          size="small"
          :title="
            on
              ? 'Alertes activées sur cet appareil'
              : `Être prévenu d'un dépassement, d'une salle coupée ou d'une machine à appairer`
          "
          @click="notifSettingsOpen = true"
        >
          {{ on ? 'Notifications ●' : 'Notifications' }}
        </Button>
        <Button id="btn-refresh" size="small" @click="refresh">Rafraîchir</Button>
        <Button id="btn-sign-out" size="small" @click="session.signOut()">Déconnexion</Button>
      </div>
    </header>

    <ConsoleNav />

    <main class="pt-4">
      <RouterView v-if="current" />
      <p
        v-else-if="permissions != null && firstOpen == null"
        id="no-access"
        class="text-[14px] text-dim"
      >
        Ce compte n'a encore accès à aucune vue. Demandez à un admin de lui attribuer un groupe.
      </p>
    </main>

    <NotificationsDialog v-model:open="notifSettingsOpen" />
    <AlertStack />
  </div>

  <Toaster />
</template>
