<script setup lang="ts">
import type { ObsState } from '@conference-operator/contract'
import { Panel } from '@conference-operator/components'
import { computed } from 'vue'
import CommandGrid, { type Command } from './CommandGrid.vue'
import SimulatedBadge from './SimulatedBadge.vue'

const BASE: Command[] = [
  { value: 'LIVE', label: 'Direct', key: 'L' },
  { value: 'HOLD', label: 'Habillage', key: 'H' },
]

const props = defineProps<{
  sceneRole: string | null
  /** The relayed room, `null` if the relay is not configured for this room. */
  relaySourceRoomId: string | null
  obs: ObsState | null
  /**
   * The roles actually mapped, when the caller knows them.
   *
   * Remotely the hub serves them: the room is not at hand, and neither is its
   * configuration. Locally the panel keeps its own rule — the relay appears as
   * soon as a source is configured — because the same machine carries it.
   */
  roles?: string[]
}>()

/*
 * The relay only appears if it is configured, and announces its source:
 * "Relais → track-2" rather than a button nobody knows what it shows.
 */
const commands = computed<Command[]>(() => {
  const relay: Command[] =
    props.relaySourceRoomId == null
      ? []
      : [{ value: 'RELAY', label: `Relais → ${props.relaySourceRoomId}` }]
  const all = [...BASE, ...relay]
  // A supplied list **filters**, it does not replace: it says what the room can
  // do, not how it is named nor in what order it is offered.
  return props.roles == null ? all : all.filter((c) => props.roles!.includes(c.value))
})
</script>

<template>
  <Panel>
    <h2 class="mb-2.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
      Projection — OBS&nbsp;A<SimulatedBadge :when="obs?.simulated === true" />
    </h2>
    <CommandGrid
      :commands="commands"
      :current="sceneRole"
      :build="(value) => ({ action: 'scene.set', role: value })"
    />
  </Panel>
</template>
