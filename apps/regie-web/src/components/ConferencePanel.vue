<script setup lang="ts">
import type { DisplayPayload } from '@cloudnord/contract'
import { Badge, Button, Panel } from '@cloudnord/components'
import { transitionRefusal } from '@cloudnord/room-state'
import { duration, time } from '@cloudnord/format'
import { computed } from 'vue'
import { nextConference, scheduleGapMs } from '../lib/countdown.js'
import { useConferenceStore } from '../stores/conference.js'
import Countdown from './Countdown.vue'

/**
 * La conférence pilotée, et les deux gestes qui la bornent.
 *
 * La **cible**, pas la session « en cours » : entre deux talks ou pendant une
 * pause, c'est la conférence qui arrive qu'on pilote — et c'est exactement à
 * ces moments-là que l'opérateur veut appuyer sur « Commencer », pendant que le
 * speaker s'installe.
 */
const props = defineProps<{ payload: DisplayPayload; nowMs: number }>()

const conference = useConferenceStore()

const session = computed(() => props.payload.state.targetSession)
const upcoming = computed(() => props.payload.state.targetIsUpcoming)
const status = computed(() =>
  session.value == null
    ? 'scheduled'
    : (props.payload.state.sessionStates?.[session.value.id] ?? 'scheduled'),
)

const speakers = computed(() =>
  (session.value?.speakers ?? []).map((person) => person.name).join(' · '),
)

const title = computed(() => {
  const target = session.value
  if (target == null) return 'Aucune conférence à piloter'
  return upcoming.value
    ? `${time(target.startsAt, props.payload.timezone)} · ${target.title}`
    : target.title
})

const badge = computed(() =>
  status.value === 'running'
    ? 'en cours'
    : status.value === 'ended'
      ? 'terminée'
      : upcoming.value
        ? 'à venir'
        : 'prête',
)

/**
 * Les deux boutons suivent la table du cycle de vie, pas une condition écrite
 * ici.
 *
 * C'est la même table que le hub applique en écriture : un bouton actif dont la
 * procédure refuserait le geste — ou l'inverse — n'est plus possible. Le refus
 * sert d'infobulle, pour que la raison soit lisible sans avoir à cliquer pour
 * la découvrir.
 */
function refusal(action: 'start' | 'end'): string | null {
  if (session.value == null) return 'Aucune conférence à piloter dans cette salle.'
  return transitionRefusal(status.value, action)
}

/** Ce que dit le programme, en toutes lettres. */
const scheduleWord = computed(() => {
  const gap = scheduleGapMs(props.payload, props.nowMs)
  if (gap == null) return ''
  const minutes = Math.round(gap / 60000)
  return minutes >= 0
    ? `${duration(minutes)} restantes au programme`
    : `dépassement de ${duration(-minutes)}`
})

/**
 * Terminée : on nomme ce que le décompte vise.
 *
 * Le grand nombre compte jusqu'à la prochaine conférence, la ligne « Suivant »
 * juste en dessous annonce le prochain *créneau* — qui peut être une pause. Les
 * deux différaient sans que rien ne l'explique. L'heure ici lève l'ambiguïté,
 * et l'annulation reste à portée.
 */
const detail = computed(() => {
  if (status.value === 'ended') {
    const next = nextConference(props.payload, props.nowMs)
    return next == null
      ? "Terminée. « Remettre à venir » si c'est une erreur."
      : `Prochaine conférence à ${time(next.startsAt, props.payload.timezone)}. ` +
          "« Remettre à venir » si c'est une erreur."
  }
  if (status.value === 'running') return scheduleWord.value
  return upcoming.value
    ? "Pas encore commencée au programme — « Commencer » reste disponible."
    : scheduleWord.value
})

/** Le dépassement est l'information qui déclenche une décision. */
const overrun = computed(() => scheduleWord.value.startsWith('dépassement'))

/**
 * La conférence suivante : elle ne se pilote pas encore, mais elle dit si l'on
 * peut laisser filer cinq minutes ou pas.
 */
const next = computed(() => {
  const from = session.value?.startsAtMs ?? props.nowMs
  return (props.payload.sessions ?? []).find((slot) => slot.startsAtMs > from) ?? null
})

const nextSpeakers = computed(() =>
  (next.value?.speakers ?? []).map((person) => person.name).join(' · '),
)
</script>

<template>
  <Panel>
    <div class="mb-2 flex items-start gap-2">
      <Badge :class="status" data-role="conference-badge">{{ badge }}</Badge>
    </div>

    <div class="mb-2 line-clamp-2 text-sm leading-snug" data-role="conference-title">
      {{ title }}
    </div>
    <div v-if="speakers !== ''" class="mb-2 line-clamp-1 text-xs text-attenue">
      {{ speakers }}
    </div>

    <Countdown :payload="payload" :at-ms="nowMs" />

    <!--
      Cliquer le détail remet à venir : c'est la seule annulation du geste, et
      elle vit là où la phrase la propose.
    -->
    <div
      class="mt-1 text-xs"
      :class="overrun ? 'text-alerte' : 'text-attenue'"
      data-role="conference-detail"
      @click="status === 'ended' && conference.reset()"
    >
      {{ detail }}
    </div>

    <div class="mt-2 border-t border-bord pt-2 text-xs text-attenue" data-role="next">
      <template v-if="next == null">Plus rien après au programme.</template>
      <template v-else>
        <span class="text-attenue">Suivant</span>
        <span class="text-texte tabular-nums"> {{ time(next.startsAt, payload.timezone) }}</span>
        <span class="text-texte"> · {{ next.title }}</span>
        <!--
          Sur une deuxième ligne : accolés au titre, les noms sortaient du cadre
          dès que le titre était long, et c'est le titre qui disparaissait.
        -->
        <div v-if="nextSpeakers !== ''" class="mt-0.5 text-texte">{{ nextSpeakers }}</div>
      </template>
    </div>

    <div class="mt-2 grid grid-cols-2 gap-1.5">
      <Button
        id="btn-conf-demarrer"
        :disabled="refusal('start') != null"
        :title="refusal('start') ?? undefined"
        :active="status === 'running'"
        @click="conference.askStart()"
      >
        Commencer
      </Button>
      <Button
        id="btn-conf-terminer"
        :disabled="refusal('end') != null"
        :title="refusal('end') ?? undefined"
        @click="conference.askEnd()"
      >
        Terminer
      </Button>
    </div>
  </Panel>
</template>
