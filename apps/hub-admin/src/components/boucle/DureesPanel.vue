<script setup lang="ts">
import { Panel, useToast } from '@conference-operator/components'
import { DUREES_PAR_DEFAUT, type DureeScene } from '@conference-operator/contract'
import { computed } from 'vue'
import { useDraft } from '../../composables/draft.js'
import { useBoucleStore } from '../../stores/boucle.js'
import SaveBar from './SaveBar.vue'
import { SMALL } from './ui.js'

/**
 * How long each kind of scene stays on screen.
 *
 * An empty field is the reference's duration, shown as its placeholder: only
 * what differs is sent, so a later change of the defaults still reaches the
 * scenes nobody touched. The pages of a kind share theirs — every sponsor page,
 * every announcement.
 */
const store = useBoucleStore()
const toast = useToast()

const LIBELLES: Record<DureeScene, string> = {
  accueil: 'Accueil',
  agenda: 'Agenda',
  annonces: 'Annonces « offert par » (chacune)',
  merci: 'Merci à nos sponsors',
  sponsors: 'Pages de sponsors (chacune)',
  'message-bienvenue': 'Message « Bienvenue »',
  salles: 'Pendant ce temps, à côté',
  'agenda-rappel': 'Agenda (rappel)',
  'message-partage': 'Message « Partage »',
  reseaux: 'Nos réseaux',
  wallsio: 'Mur social',
  'message-silence': 'Message « Téléphones »',
  conduite: 'Code de conduite',
  feedbacks: 'Feedbacks',
}
const SCENES = Object.keys(DUREES_PAR_DEFAUT) as DureeScene[]

/** One text field per kind: empty = the reference's. */
const { draft, dirty, reset } = useDraft(() =>
  store.boucle == null
    ? null
    : Object.fromEntries(SCENES.map((scene) => [scene, store.boucle!.durees[scene]?.toString() ?? ''])),
)

/** A full round of the loop, every scene shown — empty ones are skipped in the room. */
const tour = computed(() => {
  if (draft.value == null) return 0
  return SCENES.reduce((total, scene) => total + (Number(draft.value![scene]) || DUREES_PAR_DEFAUT[scene]), 0)
})

async function save(): Promise<void> {
  if (draft.value == null) return
  const durees: Partial<Record<DureeScene, number>> = {}
  for (const scene of SCENES) {
    // A number field hands back a number, or "" once emptied.
    const raw = String(draft.value[scene] ?? '').trim()
    if (raw === '') continue
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 3 || value > 600) {
      toast.fail(`${LIBELLES[scene]} : une durée entière entre 3 et 600 secondes`)
      return
    }
    if (value !== DUREES_PAR_DEFAUT[scene]) durees[scene] = value
  }
  try {
    await store.save('durees', durees)
    reset()
    toast.say('Durées enregistrées')
  } catch {
    /* already reported */
  }
}

function defaults(): void {
  if (draft.value == null) return
  for (const scene of SCENES) draft.value[scene] = ''
}
</script>

<template>
  <Panel title="Durées des scènes">
    <div v-if="draft != null" id="boucle-durees" class="flex flex-1 flex-col">
      <p class="mb-2 text-xs text-dim">En secondes. Vide = la durée de la maquette.</p>
      <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5">
        <template v-for="scene in SCENES" :key="scene">
          <label class="text-sm" :for="`boucle-duree-${scene}`">{{ LIBELLES[scene] }}</label>
          <input
            :id="`boucle-duree-${scene}`"
            v-model="draft[scene]"
            type="number"
            min="3"
            max="600"
            step="1"
            :placeholder="String(DUREES_PAR_DEFAUT[scene])"
            :class="[SMALL, 'w-20 text-right']"
          />
        </template>
      </div>
      <p class="mt-2 text-xs text-dim" data-role="tour">Tour complet, toutes les scènes affichées : {{ tour }} s</p>
      <SaveBar id="btn-boucle-durees" :dirty="dirty" @save="save">
        <button id="btn-boucle-durees-defaut" type="button" class="text-xs text-dim underline" @click="defaults">
          Revenir aux durées de la maquette
        </button>
      </SaveBar>
    </div>
  </Panel>
</template>
