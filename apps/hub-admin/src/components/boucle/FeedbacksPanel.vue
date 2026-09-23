<script setup lang="ts">
import { Panel, useToast } from '@conference-operator/components'
import { computed } from 'vue'
import { useDraft } from '../../composables/draft.js'
import { useBoucleStore } from '../../stores/boucle.js'
import SaveBar from './SaveBar.vue'
import { FIELD, LABEL, SUBTITLE, orNull } from './ui.js'

/** The event's feedback QR code — the whole day's, not a talk's. */
const store = useBoucleStore()
const toast = useToast()

const { draft, dirty, reset } = useDraft(() =>
  store.boucle == null
    ? null
    : { ...store.boucle.feedbacks, url: store.boucle.feedbacks.url ?? '' },
)

/** What the rooms draw when the field is empty: the event's OpenFeedback page. */
const derived = computed(() =>
  store.openFeedbackProjectId == null ? null : `https://openfeedback.io/${store.openFeedbackProjectId}`,
)

async function save(): Promise<void> {
  if (draft.value == null) return
  try {
    await store.save('feedbacks', { ...draft.value, url: orNull(draft.value.url) })
    reset()
    toast.say('Feedbacks enregistrés')
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <Panel title="Feedbacks de l'événement">
    <div v-if="draft != null" id="boucle-feedbacks" class="flex flex-1 flex-col">
      <label :class="LABEL" for="boucle-feedbacks-url">Adresse du QR code</label>
      <input
        id="boucle-feedbacks-url"
        v-model="draft.url"
        type="url"
        :placeholder="derived ?? 'https://…'"
        :class="FIELD"
      />
      <p v-if="draft.url.trim() === '' && derived == null" class="-mt-1.5 mb-[11px] text-xs text-warn">
        Aucun projet OpenFeedback dans Réglages : QR masqué tant que l'adresse n'est pas renseignée
      </p>

      <h3 :class="SUBTITLE">Slogan</h3>
      <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
        <input id="boucle-feedbacks-creux" v-model="draft.slogan.creux" maxlength="40" placeholder="Pensez" :class="FIELD" />
        <textarea
          id="boucle-feedbacks-orange"
          v-model="draft.slogan.orange"
          rows="2"
          maxlength="80"
          :class="FIELD"
        />
      </div>
      <h3 :class="SUBTITLE">Remerciement</h3>
      <div class="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2">
        <input id="boucle-feedbacks-merci-0" v-model="draft.merci[0]" maxlength="30" :class="FIELD" />
        <input id="boucle-feedbacks-merci-1" v-model="draft.merci[1]" maxlength="30" :class="FIELD" />
      </div>
      <SaveBar id="btn-boucle-feedbacks" :dirty="dirty" @save="save" />
    </div>
  </Panel>
</template>
