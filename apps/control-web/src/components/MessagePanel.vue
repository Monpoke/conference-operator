<script setup lang="ts">
import { Button, Panel } from '@conference-operator/components'
import { ref } from 'vue'
import { useActionsStore } from '../stores/actions.js'

/**
 * A word for the audience, on the room's screen.
 *
 * The same banner the console can project: whoever typed it, the screen shows it
 * the same way, and "Retirer" takes down whichever is up.
 */
const LEVELS = [
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Important' },
  { value: 'urgent', label: 'Urgent' },
]

/** In minutes; an empty value leaves it up until withdrawn. */
const DURATIONS = [
  { value: '', label: "Jusqu'à retrait" },
  { value: '1', label: '1 min' },
  { value: '5', label: '5 min' },
  { value: '15', label: '15 min' },
]

const props = defineProps<{
  /** What the screen holds right now, whoever put it there. */
  message: { text: string } | null
}>()

const actions = useActionsStore()
const text = ref('')
const level = ref('info')
const duration = ref('')

async function show(): Promise<void> {
  const trimmed = text.value.trim()
  if (trimmed.length === 0) return
  // The field stays filled: it says what is being projected, and fixing a typo
  // should not mean retyping the sentence.
  await actions.act({
    action: 'screen.message',
    text: trimmed,
    level: level.value,
    ttlSeconds: duration.value === '' ? null : Number(duration.value) * 60,
  })
}

async function clear(): Promise<void> {
  await actions.act({ action: 'screen.message.clear' })
}
</script>

<template>
  <Panel title="Message à l'écran">
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
        placeholder="Pause de 10 minutes…"
        class="min-w-[150px] flex-1 basis-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text focus:border-brand focus:outline-none"
        @keydown.enter="show()"
      />
      <div class="flex flex-1 flex-wrap gap-1.5">
        <select
          id="message-level"
          v-model="level"
          class="w-auto shrink-0 rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text focus:border-brand focus:outline-none"
        >
          <option v-for="option in LEVELS" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
        <select
          id="message-duration"
          v-model="duration"
          class="w-auto shrink-0 rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text focus:border-brand focus:outline-none"
        >
          <option v-for="option in DURATIONS" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
        <Button id="btn-message" class="flex-1" size="small" @click="show()">Afficher</Button>
      </div>
    </div>
    <div class="mt-1.5 flex items-center gap-1.5">
      <p id="message-current" class="min-w-0 flex-1 truncate text-[11px] text-dim">
        {{ props.message == null ? "Aucun message à l'écran" : `À l'écran : ${props.message.text}` }}
      </p>
      <Button
        id="btn-message-clear"
        size="small"
        :disabled="props.message == null"
        @click="clear()"
      >
        Retirer
      </Button>
    </div>
  </Panel>
</template>
