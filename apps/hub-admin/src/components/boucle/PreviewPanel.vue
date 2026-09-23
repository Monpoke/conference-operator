<script setup lang="ts">
import { Button, Panel, useToast } from '@conference-operator/components'
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
const toast = useToast()

/**
 * The public link: the same preview, opened without signing in.
 *
 * One key for every room — the address picks the room. Regenerating it cuts the
 * links already given out; « Désactiver » cuts them all.
 */
const lienPublic = computed(() => {
  const key = store.boucle?.lienPublic
  if (key == null) return null
  const query = new URLSearchParams({ cle: key })
  if (room.value) query.set('salle', room.value)
  return `${location.origin}/boucle/apercu?${query.toString()}`
})

function nouvelleCle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function publier(key: string | null): Promise<void> {
  try {
    await store.save('lienPublic', key)
    toast.say(key == null ? 'Lien public désactivé' : 'Lien public prêt')
  } catch {
    /* already reported */
  }
}

async function copier(): Promise<void> {
  if (lienPublic.value == null) return
  try {
    await navigator.clipboard.writeText(lienPublic.value)
    toast.say('Lien copié')
  } catch {
    toast.fail('Copie impossible : sélectionnez le lien à la main')
  }
}

const rooms = ref<{ id: string; name: string }[]>([])
const room = ref<string>('')
const hud = ref(false)
/** The time drawn, for the preview alone: empty = the hub's clock. */
const heure = ref('')
/** Its day: empty = the event's first day. */
const jour = ref('')
/** Reloads the frame by changing its address, not by reaching into it. */
const reloads = ref(0)

const src = computed(() => {
  const query = new URLSearchParams()
  if (room.value) query.set('salle', room.value)
  if (hud.value) query.set('hud', '1')
  if (heure.value) query.set('heure', heure.value)
  if (heure.value && jour.value) query.set('jour', jour.value)
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
            <option value="global">Écran global — tout le programme</option>
            <option v-for="candidate in rooms" :key="candidate.id" :value="candidate.id">{{ candidate.name }}</option>
          </select>
        </div>
        <div>
          <label :class="LABEL" for="boucle-apercu-heure">Heure</label>
          <input id="boucle-apercu-heure" v-model.lazy="heure" type="time" :class="SMALL" />
        </div>
        <div>
          <label :class="LABEL" for="boucle-apercu-jour">Jour</label>
          <input id="boucle-apercu-jour" v-model.lazy="jour" type="date" :disabled="!heure" :class="SMALL" />
        </div>
        <button
          v-if="heure"
          id="btn-boucle-apercu-heure-hub"
          type="button"
          class="pb-1.5 text-xs text-dim underline"
          @click="heure = ''; jour = ''"
        >
          Heure du hub
        </button>
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
      <div class="flex flex-wrap items-center gap-2 border-t border-edge pt-2.5" data-role="lien-public">
        <span class="text-sm">Lien public</span>
        <template v-if="lienPublic != null">
          <input
            id="boucle-lien-public"
            :value="lienPublic"
            readonly
            :class="[SMALL, 'min-w-0 flex-1 font-mono text-xs']"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <Button id="btn-boucle-lien-copier" size="small" @click="copier">Copier</Button>
          <Button id="btn-boucle-lien-regenerer" size="small" @click="publier(nouvelleCle())">Régénérer</Button>
          <Button id="btn-boucle-lien-desactiver" size="small" @click="publier(null)">Désactiver</Button>
        </template>
        <template v-else>
          <span class="text-xs text-dim">aucun : l'aperçu demande une connexion à la console.</span>
          <Button id="btn-boucle-lien-creer" size="small" @click="publier(nouvelleCle())">Créer un lien public</Button>
        </template>
      </div>
      <p class="text-xs text-dim">
        {{ heure ? `À ${heure}${jour ? ` le ${jour}` : ' le jour de l\'événement'}, pour l'aperçu seulement — les salles restent à l'heure du hub.` : 'À l\'heure du hub.' }}
        Avec les images qu'il détient. Walls.io y est toujours affiché ; en salle, il est sauté
        tant que walls.io ne répond pas.
      </p>
    </div>
  </Panel>
</template>
