<script setup lang="ts">
import { Button, Panel, useToast } from '@conference-operator/components'
import { useDraft } from '../../composables/draft.js'
import { useBoucleStore } from '../../stores/boucle.js'
import ListControls from './ListControls.vue'
import SaveBar from './SaveBar.vue'
import { FIELD, LABEL, SUBTITLE, orNull } from './ui.js'

/** The code of conduct reminder, and the QR code to the whole of it. */
const store = useBoucleStore()
const toast = useToast()
const MAX_PARAGRAPHS = 6

const { draft, dirty, reset } = useDraft(() =>
  store.boucle == null
    ? null
    : { ...store.boucle.conduite, url: store.boucle.conduite.url ?? '' },
)

async function save(): Promise<void> {
  if (draft.value == null) return
  try {
    await store.save('conduite', {
      ...draft.value,
      paragraphes: draft.value.paragraphes.filter((paragraph) => paragraph.trim() !== ''),
      url: orNull(draft.value.url),
    })
    reset()
    toast.say('Code de conduite enregistré')
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <Panel title="Code de conduite">
    <div v-if="draft != null" id="boucle-conduite" class="flex flex-1 flex-col">
      <h3 :class="SUBTITLE">Paragraphes</h3>
      <div v-for="(_, index) in draft.paragraphes" :key="index" class="mb-1.5 flex items-start gap-1.5">
        <textarea
          :id="`boucle-conduite-paragraphe-${index}`"
          v-model="draft.paragraphes[index]"
          rows="3"
          maxlength="300"
          :class="[FIELD, 'mb-0 min-w-0 flex-1']"
        />
        <ListControls :list="draft.paragraphes" :index="index" noun="le paragraphe" />
      </div>
      <div class="mb-[11px]">
        <Button
          id="btn-boucle-paragraphe-add"
          size="small"
          :disabled="draft.paragraphes.length >= MAX_PARAGRAPHS"
          @click="draft.paragraphes.push('')"
        >
          Ajouter un paragraphe
        </Button>
      </div>

      <label :class="LABEL" for="boucle-conduite-url">Adresse du code complet (QR code)</label>
      <input id="boucle-conduite-url" v-model="draft.url" type="url" placeholder="https://…" :class="FIELD" />
      <p v-if="draft.url.trim() === ''" class="-mt-1.5 mb-[11px] text-xs text-warn" data-role="qr-hidden">
        QR masqué tant que l'adresse n'est pas renseignée
      </p>
      <label :class="LABEL" for="boucle-conduite-legende">Légende du QR</label>
      <textarea id="boucle-conduite-legende" v-model="draft.legende" rows="2" maxlength="80" :class="FIELD" />

      <h3 :class="SUBTITLE">Slogan</h3>
      <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
        <input id="boucle-conduite-creux" v-model="draft.slogan.creux" maxlength="40" placeholder="Passez" :class="FIELD" />
        <textarea
          id="boucle-conduite-orange"
          v-model="draft.slogan.orange"
          rows="2"
          maxlength="80"
          :class="FIELD"
        />
      </div>
      <SaveBar id="btn-boucle-conduite" :dirty="dirty" @save="save" />
    </div>
  </Panel>
</template>
