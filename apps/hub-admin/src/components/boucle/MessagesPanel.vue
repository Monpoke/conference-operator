<script setup lang="ts">
import type { EffetMessage } from '@conference-operator/contract'
import { Panel, useToast } from '@conference-operator/components'
import { useDraft } from '../../composables/draft.js'
import { useBoucleStore } from '../../stores/boucle.js'
import SaveBar from './SaveBar.vue'
import { FIELD, LABEL, SUBTITLE } from './ui.js'

/** The three animated messages. An empty text skips the scene. */
const store = useBoucleStore()
const toast = useToast()

const MESSAGES = [
  { key: 'bienvenue', label: 'Bienvenue' },
  { key: 'partage', label: 'Partage' },
  { key: 'silence', label: 'Silence des téléphones' },
] as const

const EFFETS: { value: EffetMessage; label: string }[] = [
  { value: 'claque', label: 'Claque — les mots tombent un à un, contour violet' },
  { value: 'mots', label: 'Mots — les mots montent un à un, contour violet' },
  { value: 'eclate', label: 'Éclate — les lettres éclatent, vague de couleurs' },
  { value: 'lettres', label: 'Lettres — lettre par lettre, vague de couleurs' },
  { value: 'machine', label: 'Machine à écrire — vague de couleurs' },
]

const { draft, dirty, reset } = useDraft(() => (store.boucle == null ? null : store.boucle.messages))

async function save(): Promise<void> {
  if (draft.value == null) return
  try {
    await store.save('messages', draft.value)
    reset()
    toast.say('Messages enregistrés')
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <Panel title="Messages animés">
    <div v-if="draft != null" id="boucle-messages" class="flex flex-1 flex-col">
      <div v-for="message in MESSAGES" :key="message.key" :data-message="message.key">
        <h3 :class="SUBTITLE">{{ message.label }}</h3>
        <textarea
          :id="`boucle-message-${message.key}`"
          v-model="draft[message.key].texte"
          rows="2"
          maxlength="200"
          placeholder="Vide : la scène est sautée"
          :class="FIELD"
        />
        <label :class="LABEL" :for="`boucle-message-${message.key}-sous-titre`">Sous-titre</label>
        <input
          :id="`boucle-message-${message.key}-sous-titre`"
          v-model="draft[message.key].sousTitre"
          maxlength="120"
          :class="FIELD"
        />
        <select :id="`boucle-message-${message.key}-effet`" v-model="draft[message.key].effet" :class="FIELD">
          <option v-for="effet in EFFETS" :key="effet.value" :value="effet.value">{{ effet.label }}</option>
        </select>
      </div>
      <p class="text-xs text-dim">Un retour à la ligne dans le texte force la coupure à l'écran.</p>
      <SaveBar id="btn-boucle-messages" :dirty="dirty" @save="save" />
    </div>
  </Panel>
</template>
