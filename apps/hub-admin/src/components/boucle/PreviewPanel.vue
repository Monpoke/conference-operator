<script setup lang="ts">
import { Panel } from '@conference-operator/components'
import { computed, onMounted, ref } from 'vue'
import { useBoucleStore } from '../../stores/boucle.js'
import { useSessionStore } from '../../stores/session.js'
import { LABEL, SMALL } from './ui.js'

/**
 * The room screen, as a room would project it now.
 *
 * The hub renders the same page the rooms serve (`/boucle/apercu`), from the
 * settings it holds and on its own clock: framed here, it reloads after every
 * save, so a text corrected in a panel is checked without leaving the view. The
 * loop plays; « Panneau » opens its control panel, where the arrows and the
 * digits move from scene to scene once the frame has been clicked.
 */
const store = useBoucleStore()
const session = useSessionStore()

const rooms = ref<{ id: string; name: string }[]>([])
const room = ref<string>('')
const hud = ref(false)
/** Reloads the frame by changing its address, not by reaching into it. */
const reloads = ref(0)

const src = computed(() => {
  const query = new URLSearchParams()
  if (room.value) query.set('salle', room.value)
  if (hud.value) query.set('hud', '1')
  query.set('v', `${store.revision}-${reloads.value}`)
  return `/boucle/apercu?${query.toString()}`
})
const tab = computed(() => src.value.replace(/[?&]v=[^&]*/, ''))

onMounted(async () => {
  try {
    rooms.value = (await session.client.rpc.rooms.list()) as { id: string; name: string }[]
  } catch {
    /* already reported — the preview then shows the program's first room */
  }
})
</script>

<template>
  <Panel title="Aperçu de l'écran de salle">
    <div id="boucle-apercu" class="flex flex-col gap-2.5">
      <div class="flex flex-wrap items-end gap-2.5">
        <div>
          <label :class="LABEL" for="boucle-apercu-salle">Salle</label>
          <select id="boucle-apercu-salle" v-model="room" :class="SMALL">
            <option value="">Première salle du programme</option>
            <option v-for="candidate in rooms" :key="candidate.id" :value="candidate.id">{{ candidate.name }}</option>
          </select>
        </div>
        <label class="flex items-center gap-1.5 pb-1.5 text-sm">
          <input id="boucle-apercu-panneau" v-model="hud" type="checkbox"> Panneau
        </label>
        <button id="btn-boucle-apercu-recharger" type="button" class="rounded-lg border border-edge px-3 py-1.5 text-sm" @click="reloads += 1">
          Recharger
        </button>
        <a id="lien-boucle-apercu" :href="tab" target="_blank" rel="noopener" class="pb-1.5 text-sm text-brand underline">
          Ouvrir dans un onglet
        </a>
      </div>
      <div class="relative aspect-video w-full overflow-hidden rounded-lg border border-edge bg-black">
        <iframe
          id="boucle-apercu-cadre"
          :key="src"
          :src="src"
          title="Aperçu de l'écran de salle"
          class="absolute inset-0 h-full w-full border-0"
        />
      </div>
      <p class="text-xs text-dim">
        À l'heure du hub, avec les images qu'il détient. Walls.io y est toujours affiché ; en salle, il est sauté
        tant que walls.io ne répond pas.
      </p>
    </div>
  </Panel>
</template>
