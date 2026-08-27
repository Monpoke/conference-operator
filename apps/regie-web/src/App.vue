<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import Countdown from './components/Countdown.vue'
import RecordingTimer from './components/RecordingTimer.vue'
import RegieHeader from './components/RegieHeader.vue'
import { useClockStore } from './stores/clock.js'
import { useHostStore } from './stores/host.js'
import { useRoomStore } from './stores/room.js'

/**
 * La régie, moitié lecture.
 *
 * Ce qui commande OBS n'est pas encore ici : la page coexiste avec celle qui
 * pilote, sur `/regie-v2`, le temps que la seconde moitié se porte. Elle n'a
 * donc qu'un devoir, et c'est celui d'un écran de salle — dire la vérité, y
 * compris quand elle a cessé de la connaître.
 */
const room = useRoomStore()
const clock = useClockStore()
const host = useHostStore()

onMounted(() => {
  clock.start()
  room.connect()
  host.start()
})

onBeforeUnmount(() => {
  host.stop()
  room.disconnect()
  clock.stop()
})

const payload = computed(() => room.payload)
</script>

<template>
  <template v-if="payload != null">
    <RegieHeader :payload="payload" :now-ms="room.now" :stream-dead="room.dead" />

    <main class="min-h-0 overflow-y-auto p-3">
      <section class="rounded-xl border border-bord bg-surface p-3">
        <h2 class="mb-2.5 text-[11px] font-semibold tracking-[.14em] text-attenue uppercase">
          Conférence
        </h2>
        <Countdown :payload="payload" :at-ms="room.now" />
      </section>

      <section class="mt-2.5 rounded-xl border border-bord bg-surface p-3">
        <h2 class="mb-2.5 text-[11px] font-semibold tracking-[.14em] text-attenue uppercase">
          Captation
        </h2>
        <RecordingTimer
          :recording="payload.diagnostics?.recording ?? null"
          :real-ms="clock.real"
          :room-ms="room.now"
        />
      </section>
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
</template>
