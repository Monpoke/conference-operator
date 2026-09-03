<script setup lang="ts">
import type { ControlDiagnostics } from '@cloudnord/contract'
import { shortDuration } from '@cloudnord/format'
import { computed } from 'vue'

/**
 * Depuis combien de temps ça tourne.
 *
 * Deux horloges possibles, et la charge utile porte laquelle : un
 * `startedAtCorrectedMs` renseigné veut dire « compte sur l'horloge du hub » — le
 * cas du développement, où l'on déroule une journée en la poussant, et où le
 * chronomètre doit dire la même chose que la durée finalement enregistrée.
 * Absent, on compte en temps réel, comme en production.
 *
 * Un écart assumé avec la page d'origine, et le seul : au-delà de l'heure elle
 * affichait « 90:00 », ce format-ci affiche « 1:30:00 ». Une prise dépassant
 * l'heure existe — les keynotes — et un compte en minutes seules s'y lit mal.
 */
const props = defineProps<{
  recording: ControlDiagnostics['recording'] | null
  /** Temps réel de la machine. */
  realMs: number
  /** Heure de la salle, décalage du hub compris. */
  roomMs: number
}>()

const startedAt = computed(() =>
  props.recording?.active === true
    ? (props.recording.startedAtCorrectedMs ?? props.recording.startedAtMs)
    : null,
)

const followsHub = computed(
  () => props.recording?.active === true && props.recording.startedAtCorrectedMs != null,
)

const elapsed = computed(() => {
  const start = startedAt.value
  if (start == null) return null
  return Math.max(0, (followsHub.value ? props.roomMs : props.realMs) - start)
})
</script>

<template>
  <span
    class="text-[22px] font-bold tabular-nums"
    :class="elapsed == null ? 'text-attenue' : ''"
    data-role="recording-timer"
  >
    {{ elapsed == null ? '00:00' : shortDuration(elapsed) }}
  </span>
</template>
