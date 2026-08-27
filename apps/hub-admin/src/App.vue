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
 * La coquille de la console, et sa boucle de rafraîchissement.
 *
 * Une seule boucle qui lit `route.meta.refresh` remplace un `if/else if` de
 * trente lignes qu'il fallait étendre à la main pour chaque vue — et où oublier
 * une branche voulait dire que la vue ne se rafraîchissait simplement jamais,
 * en silence. Deux choses en tombent gratuitement : un onglet caché cesse de
 * sonder, et une vue se charge tout de suite au lieu d'attendre le tour suivant.
 */
const session = useSessionStore()
const notifications = useNotificationsStore()
const { signedIn, eventName, mode } = storeToRefs(session)
const { supported, on } = storeToRefs(notifications)
const route = useRoute()

const reglageNotifs = ref(false)
const timer = ref<ReturnType<typeof setTimeout> | null>(null)

function stop(): void {
  if (timer.value != null) clearTimeout(timer.value)
  timer.value = null
}

/**
 * `setTimeout` enchaîné, et non `setInterval`.
 *
 * L'intervalle compte à partir de la **fin** de la requête. Avec `setInterval`,
 * un hub qui répond plus lentement que la période empilait les appels les uns
 * sur les autres — c'est-à-dire précisément quand il pouvait le moins se le
 * permettre.
 */
async function tick(): Promise<void> {
  const { refresh, intervalMs } = route.meta
  if (refresh == null || !signedIn.value) return
  if (document.visibilityState === 'visible') {
    try {
      await refresh()
    } catch {
      // Déjà remonté par le crochet d'erreur du client.
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
 * Le titre suit le nom de l'événement.
 *
 * Renommer l'événement et continuer à lire l'ancien nom en haut de sa propre
 * console serait le premier endroit où douter que le réglage soit pris.
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
          @click="reglageNotifs = true"
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

    <NotificationsDialog v-model:open="reglageNotifs" />
    <AlertStack />
  </div>

  <Toaster />
</template>
