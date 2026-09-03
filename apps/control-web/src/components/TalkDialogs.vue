<script setup lang="ts">
import { ConfirmDialog } from '@cloudnord/components'
import { useTalkStore } from '../stores/talk.js'
import { useKeyboardLayer } from '../stores/keyboard.js'

/**
 * The four questions that get in the way of a start or an end.
 *
 * Together here because they chain, two by two: the early-start guard opens the
 * recording one, which starts the talk; the early-end guard opens the take one,
 * which ends it. Scattered across the panels, the order — which is the heart of
 * the matter — would be readable nowhere.
 *
 * Each lays down an empty keyboard layer, and that is not comfort: the page's
 * shortcuts act on the talk, and a reflex "r" while being asked whether to record
 * would switch the take underneath the question itself. A layer swallows
 * everything it has not bound — and these bind nothing, `ConfirmDialog` taking
 * care of the `Y` and `N` it prints itself.
 */
const talk = useTalkStore()

/*
 * Empty layers, and that is all that is needed.
 *
 * `Y` and `N` are now bound by `ConfirmDialog` itself, along with the label it
 * prints: the two can no longer diverge, and all four questions answer the
 * keyboard the same way — which was true of only two of them when each caller
 * wired its own.
 *
 * The layer stays for what it **swallows**: a reflex "r" while being asked whether
 * to record would switch the take underneath the question itself, and an "l" would
 * put the room on air. It binds nothing any more.
 */
useKeyboardLayer(() => ({}), () => talk.tooEarlyOpen)
useKeyboardLayer(() => ({}), () => talk.endEarlyOpen)
useKeyboardLayer(() => ({}), () => talk.recordingOpen)
useKeyboardLayer(() => ({}), () => talk.stopRecordingOpen)
</script>

<template>
  <!--
    Between two slots, or during a break, the control app drives the talk that is
    coming: that is what one wants at 09:48 for a 09:50 talk, and it is a trap at
    08:45 for a 09:50 talk. Nothing on screen told the two apart, and one
    "Commencer" too many wrote a talk as held from 08:45 to 08:45 — a slot marked
    as having taken place while the room was empty.
  -->
  <ConfirmDialog
    v-model:open="talk.tooEarlyOpen"
    tone="warn"
    title="Commencer très en avance ?"
    :detail="talk.tooEarlyDetail"
    cancel-label="Non"
    confirm-label="Commencer"
    @confirm="talk.start()"
  />

  <!--
    Ending is no trivial gesture: the room switches to "rien dans la salle", the
    other control apps see it, the countdown jumps to the next talk. The button
    sits next to "Commencer", and that is the kind of neighbouring that gets paid
    for once per event.
  -->
  <ConfirmDialog
    v-model:open="talk.endEarlyOpen"
    tone="warn"
    title="Terminer en avance ?"
    :detail="talk.endEarlyDetail"
    cancel-label="Non"
    confirm-label="Terminer"
    @confirm="talk.end()"
  />

  <!--
    The counterpart of "Rien n'enregistre", and it covers the oversight that one
    lets through: a take nobody stops is visible nowhere. It runs through the
    break, the next talk is written into the same file, and the start-up guard
    stays silent since a recording is running. The price is only discovered at
    editing time, when the room is dismantled.
  -->
  <ConfirmDialog
    v-model:open="talk.stopRecordingOpen"
    tone="warn"
    title="La captation tourne encore"
    :detail="talk.stopRecordingDetail"
    cancel-label="Annuler"
    confirm-label="Arrêter et terminer"
    @confirm="talk.finish(true)"
  >
    <template #other>
      <!--
        The way out for a talk recorded in one go, audience questions included,
        which overruns its slot. It is named, not hidden: removing it would force
        one to cancel, end, and then remember to stop later.
      -->
      <button
        type="button"
        class="cursor-pointer rounded-lg border border-edge bg-surface2 px-3 py-2 text-[13px] font-semibold text-text"
        @click="talk.finish(false)"
      >
        Terminer sans arrêter
      </button>
    </template>
  </ConfirmDialog>

  <ConfirmDialog
    v-model:open="talk.recordingOpen"
    tone="warn"
    title="Rien n'enregistre"
    detail="La conférence va commencer et OBS-B n'enregistre pas. Une VOD manquante ne se rattrape pas le soir."
    cancel-label="Annuler"
    confirm-label="Enregistrer et commencer"
    @confirm="talk.launch(true)"
  >
    <template #other>
      <button
        type="button"
        class="cursor-pointer rounded-lg border border-edge bg-surface2 px-3 py-2 text-[13px] font-semibold text-text"
        @click="talk.launch(false)"
      >
        Commencer sans enregistrer
      </button>
    </template>
  </ConfirmDialog>
</template>
