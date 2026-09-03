<script setup lang="ts">
import type { Connectivity } from '@cloudnord/contract'
import { computed } from 'vue'
import { clockDrift } from '../lib/clock-drift.js'
import Indicator from './Indicator.vue'
import type { Level } from './levels.js'

/**
 * The link with the hub, in its three states.
 *
 * What the tooltip adds to the colour: **what still works**. It is the operator's
 * only question when the dot changes mid-day, and the answer is
 * counter-intuitive — the room projects, records and runs its program without the
 * hub. Saying so avoids the reflex of stopping the session.
 */
const STATES: Record<Connectivity, { level: Level; word: string; value: string; label: string; verdict: string }> = {
  ONLINE: {
    level: 'ok',
    word: 'hub connecté',
    value: 'Connecté',
    label: 'échanges en direct',
    verdict: 'Commandes, remontée et programme circulent normalement.',
  },
  DEGRADED: {
    level: 'warn',
    word: 'temps réel interrompu',
    value: 'Différé',
    // Not "temps réel interrompu": the banner already says so three centimetres
    // away. The label is there to say what becomes of the rest.
    label: 'remontée en file',
    verdict:
      'Le hub répond encore, mais plus en direct : la salle continue seule et ce qu’elle produit part en file. Rien n’est perdu tant que l’application reste ouverte.',
  },
  OFFLINE: {
    level: 'alert',
    word: 'hors ligne',
    value: 'Hors ligne',
    label: 'aucun contact',
    verdict:
      'Plus rien ne circule avec le hub. Projection et captation, elles, n’en dépendent pas : continuez le talk, prévenez la console par un autre moyen.',
  },
}

const props = defineProps<{
  connectivity: Connectivity | null
  /** The uplink queue's depth. That is what one watches during an outage. */
  queueDepth: number
  offsetMs: number
  simulatedClock: boolean
}>()

const state = computed(() => STATES[props.connectivity ?? 'OFFLINE'] ?? STATES.OFFLINE)

/*
 * The clock offset is said here and nowhere else: it is what explains a countdown
 * that does not match the operator's watch.
 */
const detail = computed(() => {
  const clock = props.simulatedClock
    ? 'horloge simulée par le hub'
    : clockDrift(props.offsetMs || 0)
  const queue = props.queueDepth > 0 ? `${props.queueDepth} en attente de remontée` : 'file vide'
  return `${queue} · ${clock}`
})
</script>

<template>
  <Indicator
    title="Lien avec le hub"
    :level="state.level"
    :value="state.value"
    :label="state.label"
    :detail="detail"
    :verdict="state.verdict"
  >
    {{ state.word }}
  </Indicator>
</template>
