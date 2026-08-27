<script setup lang="ts">
import type { ModeExecution } from '@cloudnord/contract'
import { computed } from 'vue'

/**
 * Le mode d'exécution, affiché seulement quand il n'est pas celui qu'on croit.
 *
 * C'est leur **désaccord** qui compte : une salle de développement branchée sur
 * le hub de l'événement enverrait de vraies commandes depuis un poste qui
 * simule tout. Deux modes de production ne méritent aucun bandeau — ce serait
 * du bruit permanent pour une information nulle.
 */
const props = defineProps<{ mode: { salle: ModeExecution; hub: ModeExecution | null } | null }>()

const divergent = computed(() => props.mode?.hub != null && props.mode.hub !== props.mode.salle)

const shown = computed(
  () => props.mode != null && !(props.mode.salle === 'production' && (props.mode.hub ?? 'production') === 'production'),
)

const text = computed(() => {
  if (!divergent.value) return 'mode dev'
  return props.mode?.salle === 'dev' ? 'dev · hub en production' : 'hub en dev'
})
</script>

<template>
  <span v-if="shown" class="shrink-0">
    <span
      class="rounded border px-1.5 py-px text-[10px] font-semibold tracking-[.08em] uppercase"
      :class="divergent ? 'border-alerte/50 text-alerte' : 'border-attention/40 text-attention'"
    >
      {{ text }}
    </span>
  </span>
</template>
