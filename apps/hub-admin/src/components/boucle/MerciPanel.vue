<script setup lang="ts">
import { Panel, useToast } from '@conference-operator/components'
import { useDraft } from '../../composables/draft.js'
import { useBoucleStore } from '../../stores/boucle.js'
import SaveBar from './SaveBar.vue'
import { FIELD, LABEL } from './ui.js'

/** The thanks before the sponsor pages. */
const store = useBoucleStore()
const toast = useToast()

const { draft, dirty, reset } = useDraft(() =>
  store.boucle == null ? null : { merciSponsors: store.boucle.merciSponsors },
)

async function save(): Promise<void> {
  if (draft.value == null) return
  try {
    await store.save('merciSponsors', draft.value.merciSponsors)
    reset()
    toast.say('Remerciement enregistré')
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <Panel title="Merci à nos sponsors">
    <div v-if="draft != null" id="boucle-merci" class="flex flex-1 flex-col">
      <label :class="LABEL" for="boucle-merci-texte">Texte — un retour à la ligne force la coupure</label>
      <textarea id="boucle-merci-texte" v-model="draft.merciSponsors" rows="2" maxlength="80" :class="FIELD" />
      <SaveBar id="btn-boucle-merci" :dirty="dirty" @save="save" />
    </div>
  </Panel>
</template>
