<script setup lang="ts">
import type { DisplayPayload } from '@conference-operator/contract'
import { Button } from '@conference-operator/components'
import { time } from '@conference-operator/format'
import { computed } from 'vue'
import { useActionsStore } from '../stores/actions.js'

/**
 * The audience's questions, and the one that is on air.
 *
 * The list only carries those for the talk being driven: without the reminder
 * written out plainly, an empty list reads as "nobody has asked anything" when it
 * sometimes means "no talk is being driven".
 */
const props = defineProps<{ payload: DisplayPayload }>()

const actions = useActionsStore()

const questions = computed(() => props.payload.diagnostics?.questions ?? [])
const talk = computed(() => props.payload.diagnostics?.questionsSession ?? null)
const refreshedAt = computed(() => props.payload.diagnostics?.questionsRefreshedAt ?? null)
const onAir = computed(() => props.payload.state.question ?? null)

/**
 * The question already on air can be recognised.
 *
 * Otherwise one puts it up again, or hunts for which one is being projected by
 * re-reading the first three — while the speaker waits.
 */
function isOnAir(text: string): boolean {
  return onAir.value != null && onAir.value.text === text
}
</script>

<template>
  <div class="mb-2.5 flex flex-wrap items-center gap-2">
    <Button size="small" @click="actions.act({ action: 'questions.refresh' })">Relire</Button>
    <Button size="small" @click="actions.act({ action: 'question.set', text: null })">
      Retirer de l’antenne
    </Button>
    <span class="flex-1 text-xs text-dim">
      {{ refreshedAt == null ? 'Jamais relues' : `Relues ${time(refreshedAt, payload.timezone)}` }}
    </span>
  </div>

  <div class="mb-2.5 text-xs text-dim">
    <template v-if="talk == null">Aucune conférence pilotée : rien à mettre à l’antenne.</template>
    <template v-else>
      Questions posées sur <strong class="text-text">{{ talk.title }}</strong>
    </template>
  </div>

  <div v-if="questions.length === 0" class="text-xs text-dim">
    {{ talk == null ? '' : 'Aucune question sur cette conférence pour le moment.' }}
  </div>
  <div v-else class="flex flex-col gap-1.5">
    <div
      v-for="question in questions"
      :key="question.id"
      class="grid grid-cols-[auto_1fr_auto] items-center gap-2.5 rounded-md border px-2.5 py-2"
      :class="isOnAir(question.text) ? 'border-brand bg-surface2' : 'border-edge'"
      :data-question="question.id"
    >
      <span class="rounded bg-surface2 px-1.5 py-0.5 text-xs tabular-nums">
        {{ question.votes }}
      </span>
      <div>
        <div class="text-sm leading-snug">{{ question.text }}</div>
        <div v-if="question.author != null" class="mt-0.5 text-xs text-dim">
          {{ question.author }}
        </div>
      </div>
      <Button
        size="small"
        :active="isOnAir(question.text)"
        @click="
          actions.act({
            action: 'question.set',
            text: question.text,
            author: question.author === '' ? null : question.author,
          })
        "
      >
        {{ isOnAir(question.text) ? 'À l’antenne' : 'Afficher' }}
      </Button>
    </div>
  </div>

  <!--
    What "Afficher" does, and what it does not: without saying so, one clicks and
    then looks for the question on the projector.
  -->
  <p class="mt-2.5 text-[11px] leading-relaxed text-dim">
    Afficher met la question sur l’habillage de captation — elle part donc dans la VOD — et sur le
    bandeau vidéo de la salle. Pour la projeter en grand devant le public, choisir « Question
    choisie » dans Écran de salle.
  </p>
</template>
