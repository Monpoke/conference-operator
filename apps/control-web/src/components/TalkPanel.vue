<script setup lang="ts">
import type { DisplayPayload } from '@cloudnord/contract'
import { Badge, Button, Panel } from '@cloudnord/components'
import { transitionRefusal } from '@cloudnord/room-state'
import { duration, time } from '@cloudnord/format'
import { computed } from 'vue'
import { nextTalkFor, scheduleGapMs } from '../lib/countdown.js'
import { useTalkStore } from '../stores/talk.js'
import Countdown from './Countdown.vue'

/**
 * The talk being driven, and the two gestures that bound it.
 *
 * The **target**, not the "current" session: between two talks or during a break,
 * it is the talk that is coming which one drives — and it is exactly at those
 * moments that the operator wants to press "Commencer", while the speaker settles
 * in.
 */
const props = defineProps<{ payload: DisplayPayload; nowMs: number }>()

const talk = useTalkStore()

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
 * Both buttons follow the lifecycle table, not a condition written here.
 *
 * It is the same table the hub applies on write: an active button whose procedure
 * would refuse the gesture — or the reverse — is no longer possible. The refusal
 * doubles as the tooltip, so the reason is readable without having to click to
 * discover it.
 */
function refusal(action: 'start' | 'end'): string | null {
  if (session.value == null) return 'Aucune conférence à piloter dans cette salle.'
  return transitionRefusal(status.value, action)
}

/** What the program says, spelled out. */
const scheduleWord = computed(() => {
  const gap = scheduleGapMs(props.payload, props.nowMs)
  if (gap == null) return ''
  const minutes = Math.round(gap / 60000)
  return minutes >= 0
    ? `${duration(minutes)} restantes au programme`
    : `dépassement de ${duration(-minutes)}`
})

/**
 * Ended: we name what the countdown is aiming at.
 *
 * The large number counts down to the next talk, while the "Suivant" line just
 * below announces the next *slot* — which may be a break. The two differed with
 * nothing to explain it. The time here removes the ambiguity, and the undo stays
 * within reach.
 */
const detail = computed(() => {
  if (status.value === 'ended') {
    const next = nextTalkFor(props.payload, props.nowMs)
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

/** The overrun is the piece of information that triggers a decision. */
const overrun = computed(() => scheduleWord.value.startsWith('dépassement'))

/**
 * The next talk: it cannot be driven yet, but it says whether five minutes can be
 * allowed to slip or not.
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
      <Badge :class="status" data-role="talk-badge">{{ badge }}</Badge>
    </div>

    <div class="mb-2 line-clamp-2 text-sm leading-snug" data-role="talk-title">
      {{ title }}
    </div>
    <div v-if="speakers !== ''" class="mb-2 line-clamp-1 text-xs text-dim">
      {{ speakers }}
    </div>

    <Countdown :payload="payload" :at-ms="nowMs" />

    <!--
      Clicking the detail puts it back as upcoming: it is the gesture's only undo,
      and it lives where the sentence offers it.
    -->
    <div
      class="mt-1 text-xs"
      :class="overrun ? 'text-alert' : 'text-dim'"
      data-role="talk-detail"
      @click="status === 'ended' && talk.reset()"
    >
      {{ detail }}
    </div>

    <div class="mt-2 border-t border-edge pt-2 text-xs text-dim" data-role="next">
      <template v-if="next == null">Plus rien après au programme.</template>
      <template v-else>
        <span class="text-dim">Suivant</span>
        <span class="text-text tabular-nums"> {{ time(next.startsAt, payload.timezone) }}</span>
        <span class="text-text"> · {{ next.title }}</span>
        <!--
          On a second line: set beside the title, the names pushed out of the frame
          as soon as the title was long, and it was the title that disappeared.
        -->
        <div v-if="nextSpeakers !== ''" class="mt-0.5 text-text">{{ nextSpeakers }}</div>
      </template>
    </div>

    <div class="mt-2 grid grid-cols-2 gap-1.5">
      <Button
        id="btn-talk-start"
        :disabled="refusal('start') != null"
        :title="refusal('start') ?? undefined"
        :active="status === 'running'"
        @click="talk.askStart()"
      >
        Commencer
      </Button>
      <Button
        id="btn-talk-end"
        :disabled="refusal('end') != null"
        :title="refusal('end') ?? undefined"
        @click="talk.askEnd()"
      >
        Terminer
      </Button>
    </div>
  </Panel>
</template>
