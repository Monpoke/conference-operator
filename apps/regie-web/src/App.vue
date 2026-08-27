<script setup lang="ts">
import { Toaster } from '@cloudnord/components'
import { computed, onBeforeUnmount, onMounted, useTemplateRef } from 'vue'
import CapturePanel from './components/CapturePanel.vue'
import ConferenceDialogs from './components/ConferenceDialogs.vue'
import ConferencePanel from './components/ConferencePanel.vue'
import LevelMeters from './components/LevelMeters.vue'
import MessagePanel from './components/MessagePanel.vue'
import PairingVeil from './components/PairingVeil.vue'
import ProjectionPanel from './components/ProjectionPanel.vue'
import RegieHeader from './components/RegieHeader.vue'
import ScreenPanel from './components/ScreenPanel.vue'
import { useActionsStore } from './stores/actions.js'
import { useAudioStore } from './stores/audio.js'
import { useClockStore } from './stores/clock.js'
import { useHostStore } from './stores/host.js'
import { useKeyboardLayer } from './stores/keyboard.js'
import { useRoomStore } from './stores/room.js'

/**
 * La régie refaite.
 *
 * Trois colonnes qui ne défilent pas : au-dessous de 1024 px de large la grille
 * retombe sur une colonne défilante, faute de mieux, mais la disposition visée
 * est celle d'un écran de régie — tout visible, rien à chercher.
 */
const room = useRoomStore()
const clock = useClockStore()
const host = useHostStore()
const audio = useAudioStore()
const actions = useActionsStore()

const capture = useTemplateRef<InstanceType<typeof CapturePanel>>('capture')

onMounted(() => {
  clock.start()
  room.connect()
  audio.connect()
  host.start()
})

onBeforeUnmount(() => {
  host.stop()
  audio.disconnect()
  room.disconnect()
  clock.stop()
})

const payload = computed(() => room.payload)

/**
 * Une machine non appairée n'a rien à piloter.
 *
 * Le voile n'est pas posé « par-dessus » la page : il la remplace. `paired` est
 * la seule valeur qui le lève, et l'absence de bloc `pairing` aussi — une salle
 * déjà liée n'en reçoit pas.
 */
const pairingRequired = computed(
  () => payload.value?.pairing != null && payload.value.pairing.status !== 'paired',
)

/**
 * Les raccourcis de la page, sur la couche du fond.
 *
 * Dans une salle sombre, viser un bouton coûte plus cher qu'appuyer sur une
 * touche. Toute modale posera une couche par-dessus celle-ci et les avalera :
 * c'est ce qui empêche un « r » réflexe de lancer une captation sous une
 * question ouverte.
 */
useKeyboardLayer(
  () => ({
    l: () => void actions.act({ action: 'scene.set', role: 'LIVE' }),
    h: () => void actions.act({ action: 'scene.set', role: 'HOLD' }),
    r: () => capture.value?.toggleRecording(),
    m: () => capture.value?.mark(),
  }),
  /*
   * Rien sous le voile d'appairage.
   *
   * La page d'origine gardait ses raccourcis vivants derrière lui — son
   * écouteur était global et le voile n'était qu'un attribut sur le `<body>`.
   * Taper « l » sur une machine non appairée postait une bascule de scène vers
   * un OBS qu'elle n'a pas, et récoltait un échec rouge pour toute réponse.
   */
  () => !pairingRequired.value,
)
</script>

<template>
  <PairingVeil v-if="pairingRequired && payload != null" :pairing="payload.pairing" />

  <template v-else-if="payload != null">
    <RegieHeader :payload="payload" :now-ms="room.now" :stream-dead="room.dead" />

    <main
      class="grid min-h-0 gap-2.5 overflow-y-auto p-2.5 lg:grid-cols-3 lg:overflow-hidden"
    >
      <div class="flex min-h-0 flex-col gap-2.5 lg:overflow-y-auto">
        <ConferencePanel :payload="payload" :now-ms="room.now" />
      </div>

      <div class="flex min-h-0 flex-col gap-2.5 lg:overflow-y-auto">
        <ScreenPanel :mode="payload.state.mode" />
        <ProjectionPanel
          :scene-role="payload.state.sceneRole"
          :relay-source-room-id="payload.diagnostics?.relaySourceRoomId ?? null"
          :obs="payload.diagnostics?.obs.A ?? null"
        />
        <MessagePanel />
      </div>

      <div class="flex min-h-0 flex-col gap-2.5 lg:overflow-y-auto">
        <CapturePanel
          ref="capture"
          :recording="payload.diagnostics?.recording ?? null"
          :streaming="payload.state.streaming === true"
          :obs="payload.diagnostics?.obs.B ?? null"
          :real-ms="clock.real"
          :room-ms="room.now"
        />
        <LevelMeters />
      </div>
    </main>
  </template>

  <!--
    Aucun état reçu : c'est le cas du développement, où `vite dev` sert la
    coquille sans rien dedans. En salle, le poste embarque l'état dans la page
    et cet écran n'apparaît jamais.
  -->
  <div v-else class="flex items-center justify-center p-6 text-sm text-attenue">
    Connexion au poste de salle…
  </div>

  <ConferenceDialogs />
  <Toaster />
</template>
