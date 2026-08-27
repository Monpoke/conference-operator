<script setup lang="ts">
import type { ControlDiagnostics, ObsState } from '@cloudnord/contract'
import { Button, Key, Panel } from '@cloudnord/components'
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
}>()

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
   * Le refus est ici, et pas seulement sur l'attribut du bouton.
   *
   * Le raccourci `m` atteint cette fonction sans passer par le bouton : la page
   * d'origine héritait du garde-fou parce qu'elle cliquait dessus, et qu'un
   * bouton désactivé ignore le clic. Appelée directement, elle postait une
   * commande que le poste refuse — un échec clignotant pour un geste que la
   * page savait impossible.
   */
  if (!active.value) return
  // Un marqueur sans libellé reste un marqueur : au montage, savoir *où* vaut
  // déjà mieux que rien, et exiger un mot ferait rater l'instant.
  void actions.act({ action: 'recording.mark', label: label.value.trim() || 'Chapitre' })
  label.value = ''
}

const markers = computed(() => {
  if (!active.value) return 'hors enregistrement'
  const count = props.recording?.markers ?? 0
  return count === 0 ? 'aucun marqueur' : `${count} marqueur(s)`
})

defineExpose({ toggleRecording, mark })
</script>

<template>
  <Panel>
    <h2 class="mb-1.5 text-[11px] font-semibold tracking-[.14em] text-attenue uppercase">
      Captation — OBS&nbsp;B<SimulatedBadge :when="obs?.simulated === true" />
    </h2>

    <div class="mb-2 flex items-baseline gap-2.5">
      <RecordingTimer :recording="recording" :real-ms="realMs" :room-ms="roomMs" />
      <span class="text-[11px] text-attenue" data-role="markers">{{ markers }}</span>
    </div>

    <div class="grid grid-cols-2 gap-1.5">
      <Button
        id="btn-rec"
        variant="danger"
        :active="active"
        @click="toggleRecording()"
      >
        {{ active ? 'Arrêter' : 'Enregistrer' }}<Key>R</Key>
      </Button>
      <Button id="btn-stream" :active="streaming" @click="toggleStream()">
        {{ streaming ? 'Arrêter la diffusion' : 'Diffuser' }}
      </Button>
    </div>

    <div class="mt-1.5 flex gap-1.5">
      <input
        id="label-marqueur"
        v-model="label"
        type="text"
        maxlength="80"
        placeholder="Libellé du marqueur"
        class="flex-1 rounded-lg border border-bord bg-fond px-3 py-2 text-sm text-texte focus:border-marque focus:outline-none"
        :disabled="!active"
        @keydown.enter="active && mark()"
      />
      <Button id="btn-marqueur" class="shrink-0" size="small" :disabled="!active" @click="mark()">
        Marquer<Key>M</Key>
      </Button>
    </div>
  </Panel>
</template>
