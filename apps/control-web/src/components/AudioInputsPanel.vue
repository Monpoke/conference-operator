<script setup lang="ts">
import type { AudioInput } from '@conference-operator/contract'
import { Button, Panel } from '@conference-operator/components'
import { useActionsStore } from '../stores/actions.js'

/**
 * The audio sources, muted or restored on both OBS instances at once.
 *
 * The rooms feed the same microphones into OBS-A and OBS-B: the operator thinks
 * "the lapel mic", not "the lapel mic on the capture". One button per source, and
 * the state per instance only shows when they disagree — heard in the room and
 * not in the VOD, or the other way round, is exactly what has to be seen.
 *
 * The state shown is OBS's, never the click's: a mute asked for lights up once
 * OBS has confirmed it, like the scenes.
 */
const props = defineProps<{
  inputs: AudioInput[]
  /** No OBS connected: every gesture would come back as a refusal. */
  offline?: boolean
}>()

const actions = useActionsStore()

interface Reading {
  word: string
  tone: string
  label: string
  /** What the button asks for. */
  muted: boolean
}

function read(input: AudioInput): Reading {
  const known = (['A', 'B'] as const).filter((instance) => input.muted[instance] != null)
  const cut = known.filter((instance) => input.muted[instance] === true)
  const only = known.length === 1 ? ` · OBS ${known[0]} seulement` : ''
  if (cut.length === 0) return { word: `Actif${only}`, tone: 'text-ok', label: 'Couper', muted: true }
  if (cut.length === known.length) {
    return { word: `Coupé${only}`, tone: 'text-alert', label: 'Rétablir', muted: false }
  }
  // Out of step: cutting everywhere rather than restoring everywhere. A microphone
  // opened by mistake is heard by the whole room; one cut by mistake is noticed and
  // restored in a second.
  return {
    word: `Coupé sur OBS ${cut.join(' et ')} seulement`,
    tone: 'text-warn',
    label: 'Couper partout',
    muted: true,
  }
}

function toggle(input: AudioInput): void {
  if (props.offline) return
  void actions.act({ action: 'audio.mute', input: input.name, muted: read(input).muted })
}
</script>

<template>
  <Panel>
    <h2 class="mb-2.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
      Sources audio — OBS&nbsp;A et B
    </h2>

    <p v-if="offline" class="mb-2 text-xs text-warn" data-role="audio-offline">
      Aucun OBS n'est connecté : impossible de couper ou de rétablir une source. Les
      commandes reviendront dès la reconnexion.
    </p>
    <p v-else-if="inputs.length === 0" class="text-xs text-dim" data-role="audio-empty">
      Aucune source audio remontée par OBS.
    </p>

    <div class="flex flex-col gap-1.5">
      <div
        v-for="input in inputs"
        :key="input.name"
        class="flex items-center gap-2"
        :data-input="input.name"
      >
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm">{{ input.name }}</div>
          <div class="text-[11px]" :class="read(input).tone">{{ read(input).word }}</div>
        </div>
        <Button
          size="small"
          class="shrink-0"
          :variant="read(input).muted ? 'danger' : 'neutral'"
          :disabled="offline"
          @click="toggle(input)"
        >
          {{ read(input).label }}
        </Button>
      </div>
    </div>
  </Panel>
</template>
