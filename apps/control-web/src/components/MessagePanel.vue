<script setup lang="ts">
import { Button, Panel } from '@cloudnord/components'
import { ref } from 'vue'
import { useActionsStore } from '../stores/actions.js'

/**
 * A word to the console, from the room.
 *
 * It leaves through the uplink queue: that is what the note under the field says,
 * and it is true — a message sent offline will arrive all the same. Saying so
 * stops people giving up on asking for help at the exact moment they need it.
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
   * The field clears before the response, and it is the only place we allow
   * ourselves not to wait: the message leaves through the queue, it has no state
   * on screen to contradict, and retyping a sentence because the machine took a
   * second to answer is what discourages retyping it.
   */
  text.value = ''
  await actions.act({ action: 'message.send', text: trimmed, level: level.value })
}
</script>

<template>
  <Panel title="Message à la console">
    <!--
      Wraps onto two lines when the column narrows: a message field squeezed to
      six characters cannot be read back before sending.
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
          id="message-level"
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
