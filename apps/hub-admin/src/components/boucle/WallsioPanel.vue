<script setup lang="ts">
import { viewPath } from '@conference-operator/contract'
import { Panel, useToast } from '@conference-operator/components'
import { useDraft } from '../../composables/draft.js'
import { useBoucleStore } from '../../stores/boucle.js'
import SaveBar from './SaveBar.vue'
import { FIELD, LABEL } from './ui.js'

/**
 * How the social wall's page is laid out. Its posts are not set here: they
 * come from walls.io, from the audience, and from the partner posts written in
 * Modération.
 */
const store = useBoucleStore()
const toast = useToast()
const moderationPath = viewPath('moderation')
const settingsPath = viewPath('reglages')

const { draft, dirty, reset } = useDraft(() => (store.boucle == null ? null : store.boucle.wallsio))

async function save(): Promise<void> {
  if (draft.value == null) return
  try {
    await store.save('wallsio', {
      ...draft.value,
      parPage: Math.min(6, Math.max(3, Math.round(Number(draft.value.parPage) || 5))),
    })
    reset()
    toast.say('Mur social enregistré')
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <Panel title="Mur social">
    <div v-if="draft != null" id="boucle-wallsio" class="flex flex-1 flex-col">
      <p class="mb-2 text-[13px] text-dim">
        Les posts se gèrent dans <a :href="moderationPath" class="text-brand underline">Modération</a>
        (mise en avant, posts partenaires), le jeton walls.io dans
        <a :href="settingsPath" class="text-brand underline">Réglages</a>.
      </p>
      <label :class="LABEL" for="boucle-wallsio-titre">Titre</label>
      <input id="boucle-wallsio-titre" v-model="draft.titre" maxlength="60" :class="FIELD" />
      <label :class="LABEL" for="boucle-wallsio-hashtag">Hashtag</label>
      <input id="boucle-wallsio-hashtag" v-model="draft.hashtag" maxlength="40" :class="FIELD" />
      <label :class="LABEL" for="boucle-wallsio-par-page">Posts par page (3 à 6, le post mis en avant compris)</label>
      <input
        id="boucle-wallsio-par-page"
        v-model.number="draft.parPage"
        type="number"
        min="3"
        max="6"
        :class="FIELD"
      />
      <SaveBar id="btn-boucle-wallsio" :dirty="dirty" @save="save" />
    </div>
  </Panel>
</template>
