<script setup lang="ts">
import type { DisplayPayload } from '@cloudnord/contract'
import { computed } from 'vue'
import { Button, Key } from '@cloudnord/components'
import { useHostStore } from '../stores/host.js'
import CpuIndicator from './CpuIndicator.vue'
import HubIndicator from './HubIndicator.vue'
import ModeBadge from './ModeBadge.vue'
import RoomClock from './RoomClock.vue'
import ScreensMenu from './ScreensMenu.vue'

const props = defineProps<{
  payload: DisplayPayload
  /** Heure de la salle, décalage du hub compris. */
  nowMs: number
  /** Le flux de la page est coupé depuis assez longtemps pour le dire. */
  streamDead: boolean
  /**
   * Servie par le hub, sur un téléphone.
   *
   * Tombent alors : les boutons qui ouvrent des modales de poste (programme,
   * salles, ⚙, écrans) et la charge de l'hôte, servie par la machine de salle.
   * Reste tout ce qui dit **où en est la salle** — c'est la seule raison de
   * regarder cette ligne.
   */
  distant?: boolean
}>()

const emit = defineEmits<{ open: [tab: 'programme' | 'salles']; config: [] }>()

const host = useHostStore()

/*
 * La profondeur de file est l'indicateur à surveiller pendant une coupure :
 * elle se lit dans le bandeau, et se détaille dans l'info-bulle du hub.
 */
const queueDepth = computed(
  () => props.payload.diagnostics?.outboxDepth ?? props.payload.state.outboxDepth ?? 0,
)
</script>

<template>
  <header class="flex items-center gap-3 border-b border-bord bg-surface px-3 py-2">
    <div class="truncate text-[15px] font-semibold" data-role="room">
      {{ payload.roomName ?? payload.state.roomId ?? 'Salle non appairée' }}
    </div>

    <ModeBadge :mode="payload.diagnostics?.mode ?? null" />

    <HubIndicator
      :connectivity="payload.state.connectivity"
      :queue-depth="queueDepth"
      :offset-ms="payload.state.serverTimeOffsetMs"
      :simulated-clock="payload.state.simulatedClock"
    />

    <CpuIndicator v-if="distant !== true" :load="host.load" />

    <!--
      Le pilotage distant, vu de la salle.

      Il ne grise rien : l'opérateur qui est là garde toutes ses commandes, quoi
      qu'il arrive à un téléphone parti dans un couloir. Il est ici parce que
      c'est la ligne qu'on lit pour savoir dans quel état est la salle — et
      qu'une scène qui bascule sans que personne n'ait touché au clavier se lit
      sinon comme une panne, en plein talk.
    -->
    <div
      v-if="payload.state.remoteHolder != null && distant !== true"
      class="shrink-0 truncate text-xs text-attention"
      data-role="remote-holder"
      :title="`${payload.state.remoteHolder} pilote cette salle depuis la régie mobile. Vos commandes restent actives.`"
    >
      pilotée à distance — {{ payload.state.remoteHolder }}
    </div>

    <div v-if="queueDepth > 0" class="shrink-0 text-xs text-attention" data-role="queue">
      {{ queueDepth }} en attente
    </div>

    <!--
      Le flux de la page est mort : ce qui est affiché ne bouge plus.

      Sans ce mot, une page figée passe pour une page vivante — l'horloge, le
      compte à rebours et le flux des salles se redessinent chaque seconde
      depuis la dernière charge utile reçue, et continuent donc d'avancer. Seul
      l'état de la conférence reste bloqué, sur ce qu'il disait à la coupure.
      C'est exactement ce qu'on ne peut pas diagnostiquer depuis une salle.
    -->
    <div
      v-if="streamDead"
      class="shrink-0 text-xs font-semibold text-alerte"
      role="alert"
      data-role="stream-dead"
    >
      écran figé — flux interrompu
    </div>

    <RoomClock
      :at-ms="nowMs"
      :time-zone="payload.timezone"
      :simulated="payload.state.simulatedClock"
    />

    <div v-if="distant !== true" class="flex shrink-0 items-center gap-1.5">
      <Button id="btn-programme" size="small" @click="emit('open', 'programme')">
        Programme<Key>P</Key>
      </Button>
      <Button id="btn-salles" size="small" @click="emit('open', 'salles')">
        Salles<Key>S</Key>
      </Button>
      <Button
        id="btn-config"
        size="small"
        title="Configuration de la salle"
        @click="emit('config')"
      >
        ⚙
      </Button>
      <ScreensMenu :payload="payload" />
    </div>
  </header>
</template>
