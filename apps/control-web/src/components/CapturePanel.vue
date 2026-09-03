<script setup lang="ts">
import type { ControlDiagnostics, MarkerRole, ObsState } from '@cloudnord/contract'
import { NO_EDITING_MARKS } from '@cloudnord/contract'
import { Button, Key, Panel } from '@cloudnord/components'
import { shortDuration } from '@cloudnord/format'
import { computed, ref } from 'vue'
import { useActionsStore } from '../stores/actions.js'
import RecordingTimer from './RecordingTimer.vue'
import SimulatedBadge from './SimulatedBadge.vue'

const props = defineProps<{
  recording: ControlDiagnostics['recording'] | null
  streaming: boolean
  obs: ObsState | null
  realMs: number
  roomMs: number
  /**
   * Served by the hub, not by the room machine.
   *
   * Three things fall away then, each for its own reason. **The stopwatch**: the
   * hub stores only a boolean, and showing a wrong duration beside a correct red
   * dot is worse than showing nothing. **The marker** and **the footage**: they
   * require the room's disk, which no phone reaches.
   */
  remote?: boolean
}>()

const emit = defineEmits<{ vod: [] }>()

const actions = useActionsStore()
const label = ref('')

const active = computed(() => props.recording?.active === true)

function toggleRecording(): void {
  void actions.act({ action: active.value ? 'recording.stop' : 'recording.start' })
}

function toggleStream(): void {
  void actions.act({ action: props.streaming ? 'stream.stop' : 'stream.start' })
}

function mark(): void {
  /*
   * The refusal lives here, and not only on the button's attribute.
   *
   * The `m` shortcut reaches this function without going through the button: the
   * original page inherited the guard because it clicked on it, and a disabled
   * button ignores the click. Called directly, it posted a command the machine
   * refuses — a flashing failure for a gesture the page knew to be impossible.
   */
  if (!active.value) return
  // A marker with no label is still a marker: at editing time, knowing *where* is
  // already better than nothing, and demanding a word would miss the moment.
  void actions.act({ action: 'recording.mark', label: label.value.trim() || 'Chapitre' })
  label.value = ''
}

const markers = computed(() => {
  if (!active.value) return 'hors enregistrement'
  const count = props.recording?.markers ?? 0
  return count === 0 ? 'aucun marqueur' : `${count} marqueur(s)`
})

const editing = computed(() => props.recording?.editing ?? NO_EDITING_MARKS)

/**
 * What an anchor button carries: its name, and where it fell.
 *
 * The offset rather than a simple lit button. Both say "it is set", but only one
 * answers the next question — "set *where*?" — and that is the one asked when
 * hesitating over setting it again.
 */
function anchorLabel(name: string, ms: number | null): string {
  return ms == null ? name : `${name} · ${shortDuration(ms)}`
}

/**
 * Sets one of the two editing anchors.
 *
 * The label is written here and not typed: it is what gets read back in the hub's
 * log, and it must say the same thing from one room to the next. The machine, for
 * its part, only reads `role`.
 */
function anchor(role: MarkerRole): void {
  // The same guard as `mark()`, and for the same reason: `d` and `f` reach this
  // function without going through the button, which an attribute disables in vain.
  if (!active.value) return
  void actions.act({ action: 'recording.mark', label: role === 'debut' ? 'Début' : 'Fin', role })
}

defineExpose({ toggleRecording, mark, anchor })
</script>

<template>
  <Panel>
    <div class="mb-1.5 flex items-center gap-2">
      <h2 class="flex-1 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
        Captation — OBS&nbsp;B<SimulatedBadge :when="obs?.simulated === true" />
      </h2>
      <!--
        Checking the footage happens during the event or never: the room is
        dismantled long before anybody opens the files. Discreet all the same — it
        is not a command for the running talk, and nothing must let it be confused
        with "Enregistrer".
      -->
      <button
        v-if="remote !== true"
        type="button"
        class="shrink-0 cursor-pointer rounded border border-transparent px-1.5 py-0.5 text-[13px] leading-none opacity-60 hover:border-edge hover:opacity-100"
        aria-label="Vérifier les enregistrements"
        title="Lister, contrôler et prévisualiser les enregistrements déjà produits"
        data-role="btn-vod"
        @click="emit('vod')"
      >
        🎞
      </button>
    </div>

    <div v-if="remote !== true" class="mb-2 flex items-baseline gap-2.5">
      <RecordingTimer :recording="recording" :real-ms="realMs" :room-ms="roomMs" />
      <span class="text-[11px] text-dim" data-role="markers">{{ markers }}</span>
    </div>

    <!--
      Remotely, the indicator without the duration: what the hub really knows.
      A stopwatch would need the start time, which `room_state` does not carry —
      and an invented duration beside a correct red dot would cast doubt on both.
    -->
    <div v-else class="mb-2 text-sm" :class="active ? 'text-alert' : 'text-dim'">
      {{ active ? 'Enregistrement en cours' : 'Aucun enregistrement' }}
    </div>

    <div class="grid grid-cols-2 gap-1.5">
      <Button
        id="btn-rec"
        variant="danger"
        :active="active"
        @click="toggleRecording()"
      >
        {{ active ? 'Arrêter' : 'Enregistrer' }}<Key v-if="remote !== true">R</Key>
      </Button>
      <Button id="btn-stream" :active="streaming" @click="toggleStream()">
        {{ streaming ? 'Arrêter la diffusion' : 'Diffuser' }}
      </Button>
    </div>

    <!--
      The two anchors, above the label field and below "Enregistrer".

      They belong to the take, not to the chaptering: they are what decides what
      editing will publish, and tucking them under the input would have made them
      read as two ready-made labels among others. The offset shows as soon as they
      are set — setting again corrects, and one has to be able to see what is being
      corrected.
    -->
    <div v-if="remote !== true" class="mt-1.5 grid grid-cols-2 gap-1.5">
      <Button
        id="btn-anchor-start"
        size="small"
        :active="editing.startMs != null"
        :disabled="!active"
        title="Là où commence ce qu'on publie : le editing coupe tout ce qui précède. Reposer remplace le repère précédent."
        data-role="anchor-start"
        @click="anchor('debut')"
      >
        {{ anchorLabel('Début', editing.startMs) }}<Key>D</Key>
      </Button>
      <Button
        id="btn-anchor-end"
        size="small"
        :active="editing.endMs != null"
        :disabled="!active"
        title="Là où finit ce qu'on publie : le editing coupe tout ce qui suit. Reposer remplace le repère précédent."
        data-role="anchor-end"
        @click="anchor('fin')"
      >
        {{ anchorLabel('Fin', editing.endMs) }}<Key>F</Key>
      </Button>
    </div>

    <div v-if="remote !== true" class="mt-1.5 flex gap-1.5">
      <input
        id="label-marker"
        v-model="label"
        type="text"
        maxlength="80"
        placeholder="Libellé du marqueur"
        class="flex-1 rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text focus:border-brand focus:outline-none"
        :disabled="!active"
        @keydown.enter="active && mark()"
      />
      <Button id="btn-marker" class="shrink-0" size="small" :disabled="!active" @click="mark()">
        Marquer<Key>M</Key>
      </Button>
    </div>
  </Panel>
</template>
