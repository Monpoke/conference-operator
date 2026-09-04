<script setup lang="ts">
import { Badge, Button, Toaster } from '@cloudnord/components'
import { storeToRefs } from 'pinia'
import { onScopeDispose, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
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
const { signedIn, eventName, mode, identity } = storeToRefs(session)
const { supported, on } = storeToRefs(notifications)
const route = useRoute()

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
  if (refresh == null || !signedIn.value) return
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
  [() => route.fullPath, signedIn],
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
  (nom) => {
    if (nom !== '') document.title = `${nom} — console hub`
  },
  { immediate: true },
)

onScopeDispose(stop)

function rafraichir(): void {
  void route.meta.refresh?.()
}
</script>

<template>
  <SignInScreen v-if="!signedIn" />

  <div v-else id="console" class="mx-auto min-h-dvh max-w-[1180px] p-3 sm:p-5">
    <header class="flex flex-wrap items-center gap-3 pb-3">
      <h1 id="titre-console" class="text-[17px] font-semibold sm:text-[19px]">
        {{ eventName }} — console hub
      </h1>
      <Badge v-if="mode !== 'production'" id="badge-mode" variant="warning">{{ mode }}</Badge>
      <!--
        Qui est connecté, quand le hub le dit. Le retour de Google ne laisse
        aucun jeton derrière lui : c'est la seule confirmation qu'on a bien
        atterri avec le bon compte.
      -->
      <div v-if="identity != null" id="identite" class="hidden text-[13px] text-dim sm:block">
        {{ identity }}
      </div>
      <div class="ml-auto flex gap-1.5">
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
        <Button id="btn-rafraichir" size="small" @click="rafraichir">Rafraîchir</Button>
        <Button id="btn-deconnexion" size="small" @click="session.signOut()">Déconnexion</Button>
      </div>
    </header>

    <ConsoleNav />

    <main class="pt-4">
      <RouterView />
    </main>

    <NotificationsDialog v-model:open="notifSettingsOpen" />
    <AlertStack />
  </div>

  <Toaster />
</template>
