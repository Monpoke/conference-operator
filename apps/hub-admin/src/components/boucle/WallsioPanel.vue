<script setup lang="ts">
import { viewPath } from '@conference-operator/contract'
import { Panel, useToast } from '@conference-operator/components'
import { useDraft } from '../../composables/draft.js'
import { useBoucleStore } from '../../stores/boucle.js'
import SaveBar from './SaveBar.vue'
import { FIELD, LABEL } from './ui.js'

/**
 * How the walls.io wall is shown. The wall's address itself stays in Réglages,
 * next to the screens it switches on.
 */
const store = useBoucleStore()
const toast = useToast()
const settingsPath = viewPath('reglages')

const { draft, dirty, reset } = useDraft(() => (store.boucle == null ? null : store.boucle.wallsio))

async function save(): Promise<void> {
  if (draft.value == null) return
  try {
    await store.save('wallsio', {
      ...draft.value,
      zoom: Math.min(3, Math.max(0.5, Number(draft.value.zoom) || 1)),
      rechargeMinutes: Math.min(1440, Math.max(0, Math.round(Number(draft.value.rechargeMinutes) || 0))),
    })
    reset()
    toast.say('Mur walls.io enregistré')
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <Panel title="Mur social (walls.io)">
    <div v-if="draft != null" id="boucle-wallsio" class="flex flex-1 flex-col">
      <p class="mb-2 text-[13px] text-dim">
        L'adresse du mur se règle dans <a :href="settingsPath" class="text-brand underline">Réglages</a>, avec
        les écrans de salle.
      </p>
      <label :class="LABEL" for="boucle-wallsio-titre">Titre</label>
      <input id="boucle-wallsio-titre" v-model="draft.titre" maxlength="60" :class="FIELD" />
      <label :class="LABEL" for="boucle-wallsio-hashtag">Hashtag</label>
      <input id="boucle-wallsio-hashtag" v-model="draft.hashtag" maxlength="40" :class="FIELD" />
      <label :class="LABEL" for="boucle-wallsio-options">Options ajoutées à l'adresse</label>
      <input id="boucle-wallsio-options" v-model="draft.options" maxlength="300" :class="[FIELD, 'font-mono']" />
      <div class="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2">
        <div>
          <label :class="LABEL" for="boucle-wallsio-zoom">Agrandissement (0,5 à 3)</label>
          <input
            id="boucle-wallsio-zoom"
            v-model.number="draft.zoom"
            type="number"
            min="0.5"
            max="3"
            step="0.1"
            :class="FIELD"
          />
        </div>
        <div>
          <label :class="LABEL" for="boucle-wallsio-recharge">Recharger toutes les… (min, 0 = jamais)</label>
          <input
            id="boucle-wallsio-recharge"
            v-model.number="draft.rechargeMinutes"
            type="number"
            min="0"
            max="1440"
            :class="FIELD"
          />
        </div>
      </div>
      <SaveBar id="btn-boucle-wallsio" :dirty="dirty" @save="save" />
    </div>
  </Panel>
</template>
