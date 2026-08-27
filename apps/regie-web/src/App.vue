<script setup lang="ts">
import { Panel, Toaster } from '@cloudnord/components'
import { computed, onBeforeUnmount, onMounted, useTemplateRef } from 'vue'
import CapturePanel from './components/CapturePanel.vue'
import Countdown from './components/Countdown.vue'
import LevelMeters from './components/LevelMeters.vue'
import MessagePanel from './components/MessagePanel.vue'
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
 * Les raccourcis de la page, sur la couche du fond.
 *
 * Dans une salle sombre, viser un bouton coûte plus cher qu'appuyer sur une
 * touche. Toute modale posera une couche par-dessus celle-ci et les avalera :
 * c'est ce qui empêche un « r » réflexe de lancer une captation sous une
 * question ouverte.
 */
useKeyboardLayer(() => ({
  l: () => void actions.act({ action: 'scene.set', role: 'LIVE' }),
  h: () => void actions.act({ action: 'scene.set', role: 'HOLD' }),
  r: () => capture.value?.toggleRecording(),
  m: () => capture.value?.mark(),
}))
</script>

<template>
  <template v-if="payload != null">
    <RegieHeader :payload="payload" :now-ms="room.now" :stream-dead="room.dead" />

    <main
      class="grid min-h-0 gap-2.5 overflow-y-auto p-2.5 lg:grid-cols-3 lg:overflow-hidden"
    >
      <div class="flex min-h-0 flex-col gap-2.5 lg:overflow-y-auto">
        <Panel title="Conférence">
          <Countdown :payload="payload" :at-ms="room.now" />
        </Panel>
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

  <Toaster />
</template>
