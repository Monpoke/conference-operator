<script setup lang="ts">
import { Panel, useToast } from '@conference-operator/components'
import { useDraft } from '../../composables/draft.js'
import { useBoucleStore } from '../../stores/boucle.js'
import SaveBar from './SaveBar.vue'

/** How the day's agenda reads on the loop. */
const store = useBoucleStore()
const toast = useToast()

const { draft, dirty, reset } = useDraft(() => (store.boucle == null ? null : { ...store.boucle.agenda }))

async function save(): Promise<void> {
  if (draft.value == null) return
  try {
    await store.save('agenda', draft.value)
    reset()
    toast.say('Agenda enregistré')
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <Panel title="Agenda">
    <div v-if="draft != null" id="boucle-agenda" class="flex flex-1 flex-col">
      <label class="flex items-baseline gap-3 py-1.5">
        <input id="boucle-agenda-terminees" v-model="draft.masquerTerminees" type="checkbox" class="w-auto" />
        <span>
          <strong class="block text-sm">Masquer les sessions terminées</strong>
          <span class="text-xs text-dim">Le reste de la journée prend la place.</span>
        </span>
      </label>
      <label class="flex items-baseline gap-3 py-1.5">
        <input id="boucle-agenda-plenieres" v-model="draft.plenieres" type="checkbox" class="w-auto" />
        <span>
          <strong class="block text-sm">Plénières dans toutes les salles</strong>
          <span class="text-xs text-dim">Un créneau seul sur son horaire (la keynote d'ouverture) s'affiche partout.</span>
        </span>
      </label>
      <SaveBar id="btn-boucle-agenda" :dirty="dirty" @save="save" />
    </div>
  </Panel>
</template>
