<script setup lang="ts">
import type { ObsState } from '@cloudnord/contract'
import { Panel } from '@cloudnord/components'
import { computed } from 'vue'
import CommandGrid, { type Command } from './CommandGrid.vue'
import SimulatedBadge from './SimulatedBadge.vue'

const BASE: Command[] = [
  { value: 'LIVE', label: 'Direct', key: 'L' },
  { value: 'HOLD', label: 'Habillage', key: 'H' },
]

const props = defineProps<{
  sceneRole: string | null
  /** Salle relayée, `null` si le relais n'est pas configuré pour cette salle. */
  relaySourceRoomId: string | null
  obs: ObsState | null
}>()

/*
 * Le relais n'apparaît que s'il est configuré, et annonce sa source :
 * « Relais → track-2 » plutôt qu'un bouton dont personne ne sait ce qu'il
 * montre.
 */
const commands = computed<Command[]>(() =>
  props.relaySourceRoomId == null
    ? BASE
    : [...BASE, { value: 'RELAY', label: `Relais → ${props.relaySourceRoomId}` }],
)
</script>

<template>
  <Panel>
    <h2 class="mb-2.5 text-[11px] font-semibold tracking-[.14em] text-attenue uppercase">
      Projection — OBS&nbsp;A<SimulatedBadge :when="obs?.simulated === true" />
    </h2>
    <CommandGrid
      :commands="commands"
      :current="sceneRole"
      :build="(value) => ({ action: 'scene.set', role: value })"
    />
  </Panel>
</template>
