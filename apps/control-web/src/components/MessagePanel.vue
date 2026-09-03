<script setup lang="ts">
import { Button, Panel } from '@cloudnord/components'
import { ref } from 'vue'
import { useActionsStore } from '../stores/actions.js'

/**
 * Un mot à la console, depuis la salle.
 *
 * Part par la file de remontée : c'est ce que dit la mention sous le champ, et
 * c'est vrai — un message envoyé hors ligne arrivera quand même. Le dire évite
 * qu'on renonce à demander de l'aide au moment précis où l'on en a besoin.
 */
const LEVELS = [
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Important' },
  { value: 'urgent', label: 'Urgent' },
]

const actions = useActionsStore()
const text = ref('')
const level = ref('info')

async function send(): Promise<void> {
  const trimmed = text.value.trim()
  if (trimmed.length === 0) return
  /*
   * Le champ se vide avant la réponse, et c'est le seul endroit où l'on
   * s'allowed à ne pas attendre : le message part par la file, il n'a pas
   * d'état à l'écran à contredire, et retaper une phrase parce que le poste a
   * mis une seconde à répondre est ce qui décourage de la retaper.
   */
  text.value = ''
  await actions.act({ action: 'message.send', text: trimmed, level: level.value })
}
</script>

<template>
  <Panel title="Message à la console">
    <!--
      Repasse sur deux lignes quand la colonne se resserre : un champ de message
      réduit à six caractères ne se relit pas avant d'envoyer.
    -->
    <div class="flex flex-wrap gap-1.5">
      <input
        id="message-text"
        v-model="text"
        type="text"
        maxlength="500"
        placeholder="Besoin d'aide, question…"
        class="min-w-[150px] flex-1 rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text focus:border-brand focus:outline-none"
        @keydown.enter="send()"
      />
      <div class="flex flex-1 gap-1.5">
        <select
          id="message-niveau"
          v-model="level"
          class="w-auto shrink-0 rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text focus:border-brand focus:outline-none"
        >
          <option v-for="option in LEVELS" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
        <Button id="btn-message" class="flex-1" size="small" @click="send()">Envoyer</Button>
      </div>
    </div>
    <p class="mt-1.5 text-[11px] text-dim">
      Part par la file de remontée : un message envoyé hors ligne arrivera quand même.
    </p>
  </Panel>
</template>
