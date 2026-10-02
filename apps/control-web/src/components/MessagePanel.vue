<script setup lang="ts">
import { Button, ConfirmDialog, Panel } from '@conference-operator/components'
import { computed, ref } from 'vue'
import { useActionsStore } from '../stores/actions.js'
import { useKeyboardLayer } from '../stores/keyboard.js'

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

/**
 * Urgent asks for the control app's PIN, set on the hub.
 *
 * It takes over the room's screen, the live banner and the hall screen: a control
 * machine left unattended must not be enough. The machine checks the PIN itself,
 * hub or no hub — see `pin.ts` on the room side.
 */
const pinOpen = ref(false)
const pin = ref('')
const pinReady = computed(() => /^\d{4,12}$/.test(pin.value))
// The page's one-letter shortcuts must not fire while the PIN is typed.
useKeyboardLayer(() => ({}), () => pinOpen.value)

async function show(): Promise<void> {
  const trimmed = text.value.trim()
  if (trimmed.length === 0) return
  if (level.value === 'urgent') {
    pin.value = ''
    pinOpen.value = true
    return
  }
  await send()
}

async function send(code?: string): Promise<void> {
  // The field stays filled: it says what is being projected, and fixing a typo
  // should not mean retyping the sentence.
  await actions.act({
    action: 'screen.message',
    text: text.value.trim(),
    level: level.value,
    ttlSeconds: duration.value === '' ? null : Number(duration.value) * 60,
    ...(code != null ? { pin: code } : {}),
  })
}

function confirmUrgent(): void {
  const code = pin.value
  pin.value = ''
  void send(code)
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
    <ConfirmDialog
      v-model:open="pinOpen"
      title="⚠ Message urgent"
      tone="warn"
      danger
      confirm-label="Afficher l'urgent"
      :confirm-disabled="!pinReady"
      :confirm-key="null"
      :cancel-key="null"
      @confirm="confirmUrgent"
    >
      <div class="rounded-lg border-2 border-alert p-3" data-role="urgent-warning">
        <p class="text-sm font-semibold text-alert">
          Projeté en urgence sur l'écran de la salle, sur le bandeau live et sur l'écran global du
          hall.
        </p>
        <p class="mt-2 rounded-lg border border-edge bg-canvas p-3 text-[15px] break-words">{{ text }}</p>
      </div>
      <label class="mt-3 block text-xs text-dim" for="urgent-pin">Code PIN régie</label>
      <input
        id="urgent-pin"
        v-model="pin"
        type="password"
        inputmode="numeric"
        autocomplete="off"
        maxlength="12"
        class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text focus:border-brand focus:outline-none"
        @keydown.enter.prevent="pinReady && ((pinOpen = false), confirmUrgent())"
      />
    </ConfirmDialog>
  </Panel>
</template>
