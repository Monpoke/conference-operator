<script setup lang="ts">
import type { Connectivity } from '@cloudnord/contract'
import { computed } from 'vue'
import { clockDrift } from '../lib/clock-drift.js'
import Indicator from './Indicator.vue'
import type { Level } from './levels.js'

/**
 * Le lien avec le hub, dans ses trois états.
 *
 * Ce que l'info-bulle ajoute à la couleur : **ce qui marche encore**. C'est la
 * seule question de l'opérateur quand la pastille change en pleine journée, et
 * la réponse est contre-intuitive — la salle projette, capte et déroule son
 * programme sans le hub. Le dire évite l'arrêt de séance réflexe.
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
    // Pas « temps réel interrompu » : le bandeau le dit déjà à trois
    // centimètres de là. L'étiquette sert à dire ce qu'il advient du reste.
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
  /** Profondeur de la file de remontée. C'est elle qu'on surveille en coupure. */
  queueDepth: number
  offsetMs: number
  simulatedClock: boolean
}>()

const state = computed(() => STATES[props.connectivity ?? 'OFFLINE'] ?? STATES.OFFLINE)

/*
 * L'écart d'horloge se dit ici et nulle part ailleurs : c'est ce qui explique
 * un compte à rebours qui ne colle pas à la montre de l'opérateur.
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
