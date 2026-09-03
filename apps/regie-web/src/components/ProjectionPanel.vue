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
  /**
   * Les rôles réellement mappés, quand l'appelant les connaît.
   *
   * À distance, le hub les sert : la salle n'est pas sous la main, et sa
   * configuration non plus. En local le panneau garde sa règle — le relais
   * apparaît dès qu'une source est configurée —, parce que c'est la même
   * machine qui la porte.
   */
  roles?: string[]
}>()

/*
 * Le relais n'apparaît que s'il est configuré, et annonce sa source :
 * « Relais → track-2 » plutôt qu'un bouton dont personne ne sait ce qu'il
 * montre.
 */
const commands = computed<Command[]>(() => {
  const relais: Command[] =
    props.relaySourceRoomId == null
      ? []
      : [{ value: 'RELAY', label: `Relais → ${props.relaySourceRoomId}` }]
  const toutes = [...BASE, ...relais]
  // Une liste fournie **filtre**, elle ne remplace pas : elle dit ce que la
  // salle sait faire, pas comment on le nomme ni dans quel ordre on l'offre.
  return props.roles == null ? toutes : toutes.filter((c) => props.roles!.includes(c.value))
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
