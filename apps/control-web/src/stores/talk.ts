import { remaining, time } from '@conference-operator/format'
import {
  earlyByMs as earlyOf,
  endAsksStopRecording,
  endEarly,
  endSteps,
  leftMs as leftOf,
  runTalkSteps,
  startAsksRecording,
  startSteps,
  startTooEarly,
  talkSettings,
  type TalkFlowInput,
} from '@conference-operator/room-state/talk-flow'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useActionsStore, type ActionResult } from './actions.js'
import { useRoomStore } from './room.js'

// The rule lives in the shared flow; re-exported for whoever read it from here.
export { TOO_EARLY_MS } from '@conference-operator/room-state/talk-flow'

/**
 * Starting and ending, with whatever gets in the way.
 *
 * Four questions, and their order is the heart of the matter. On each side, the
 * one about **the talk** comes before the one about the **take**: "start very
 * early?" before "nothing is recording", "end early?" before "the take is still
 * running". The other way round, one would start a take for a talk one is about
 * to decline to start, and cut the take of a talk one is about to decline to end.
 *
 * The flow lives in a store and not in the panel because these are sequences, not
 * a rendering: "if the recording does not start, do not begin" is read back and
 * checked here, without mounting three modals.
 */
export const useTalkStore = defineStore('talk', () => {
  const room = useRoomStore()
  const actions = useActionsStore()

  const tooEarlyOpen = ref(false)
  const recordingOpen = ref(false)
  const endEarlyOpen = ref(false)
  const stopRecordingOpen = ref(false)
  /** The list of the room's talks, to force one or swap two. */
  const forceOpen = ref(false)

  const session = computed(() => room.payload?.state.targetSession ?? null)

  /** The talk forced into the room by hand, or `null` when the clock decides. */
  const pinnedSessionId = computed(() => room.payload?.state.pinnedSessionId ?? null)

  /** The target is there because someone forced it, not because of the hour. */
  const forced = computed(
    () => pinnedSessionId.value != null && pinnedSessionId.value === session.value?.id,
  )

  /** What OBS-B is really doing, observed and not assumed. */
  const recording = computed(() => room.payload?.diagnostics?.recording?.active === true)

  /**
   * The room as the shared flow reads it (`room-state/talk-flow`): the same
   * questions and the same steps as every other surface that starts a talk.
   */
  const flow = computed<TalkFlowInput>(() => ({
    nowMs: room.now,
    target: session.value,
    pinnedSessionId: pinnedSessionId.value,
    recording: recording.value,
    config: room.payload?.diagnostics?.config ?? null,
  }))

  /** The start settings, defaults included — see `talkSettings`. */
  const settings = computed(() => talkSettings(flow.value.config))

  /** How early against the slot, or `null` with no talk to drive. */
  const earlyByMs = computed(() => earlyOf(flow.value))

  /** What is left of the slot, or `null` on a slot with no end time. */
  const leftMs = computed(() => leftOf(flow.value))

  const tooEarlyDetail = computed(() => {
    const target = session.value
    const early = earlyByMs.value
    if (target == null || early == null) return ''
    const at = time(target.startsAt, room.payload?.timezone)
    return (
      `« ${target.title} » est au programme à ${at}, dans ${remaining(early)}. ` +
      'La lancer maintenant l’inscrira comme tenue à cette heure-ci, ' +
      'dans le programme comme dans l’historique du hub.'
    )
  })

  const endEarlyDetail = computed(() => {
    const target = session.value
    const left = leftMs.value
    if (target == null || left == null) return ''
    return (
      `Il reste ${remaining(left)} au créneau de « ${target.title} ». ` +
      'La salle passera à « rien dans la salle », et les autres régies le verront. ' +
      '« Remettre à venir » annule, si c’est une erreur.'
    )
  })

  const stopRecordingDetail = computed(() => {
    const target = session.value
    return (
      `OBS-B enregistre encore${target == null ? '' : ` « ${target.title} »`}. ` +
      'Laisser tourner écrira le talk suivant dans le même fichier, sous le titre ' +
      'et les intervenants de celui-ci — et le garde-fou du démarrage se taira, ' +
      'puisqu’une captation tourne.'
    )
  })

  /**
   * First guard: is this really the talk being aimed at?
   *
   * A forced talk has already answered it: someone picked it from the list and
   * pressed "Forcer maintenant". Asking again whether it is early would put the
   * same question twice to the one person who knows it best.
   */
  function askStart(): void {
    if (!startTooEarly(flow.value)) {
      void start()
      return
    }
    tooEarlyOpen.value = true
  }

  /** Second guard: the VOD, which cannot be made good in the evening. */
  async function start(): Promise<void> {
    tooEarlyOpen.value = false
    if (startAsksRecording(flow.value)) {
      recordingOpen.value = true
      return
    }
    await launch(false)
  }

  /** @param record Start the recording first, then the talk — see `startSteps`. */
  async function launch(record: boolean): Promise<void> {
    recordingOpen.value = false
    await runTalkSteps(startSteps(flow.value, record), (gesture) => actions.act(gesture))
  }

  /**
   * Ending, with a guard when it is early.
   *
   * Early only: ending on time or in overrun is the day's normal gesture, and
   * confirming it every time would turn it into a reflex. A slot with no end time
   * cannot be early — nothing to ask.
   */
  function askEnd(): void {
    if (!endEarly(flow.value)) {
      void end()
      return
    }
    endEarlyOpen.value = true
  }

  /**
   * The talk is indeed the one being ended: that leaves the take.
   *
   * The question only comes up here. Bar the stop, a forgotten take is visible
   * nowhere: nothing blinks, the indicator says "recording" as it did during the
   * talk, and the price is only discovered at editing time.
   */
  async function end(): Promise<void> {
    endEarlyOpen.value = false
    if (endAsksStopRecording(flow.value)) {
      stopRecordingOpen.value = true
      return
    }
    await finish(false)
  }

  /** @param stop Stop the take first, then end the talk — see `endSteps`. */
  async function finish(stop: boolean): Promise<void> {
    stopRecordingOpen.value = false
    await runTalkSteps(endSteps(stop), (gesture) => actions.act(gesture))
  }

  /** Putting it back as upcoming, when "Terminer" was a mistake. */
  async function reset(): Promise<void> {
    await actions.act({ action: 'session.reset' })
  }

  /**
   * Forcing a talk into the room, or giving the room back to the clock.
   *
   * The emergency gesture — a speaker stuck in a train, the next one ready. It
   * starts nothing: "Commencer" stays the gesture that writes the talk as held.
   *
   * @param sessionId One of the room's talks, or `null` to lift the pin.
   */
  async function pin(sessionId: string | null): Promise<ActionResult> {
    return actions.act({ action: 'session.pin', sessionId })
  }

  /**
   * Swapping two of the room's slots in the programme.
   *
   * The hub refuses it once either talk has run or ended: the refusal comes back
   * as the usual notice, and nothing is painted ahead of it.
   */
  async function swap(a: string, b: string): Promise<ActionResult> {
    return actions.act({ action: 'session.swap', a, b })
  }

  return {
    tooEarlyOpen,
    recordingOpen,
    endEarlyOpen,
    stopRecordingOpen,
    forceOpen,
    settings,
    recording,
    earlyByMs,
    leftMs,
    tooEarlyDetail,
    endEarlyDetail,
    stopRecordingDetail,
    askStart,
    start,
    launch,
    askEnd,
    end,
    finish,
    reset,
    pinnedSessionId,
    forced,
    pin,
    swap,
  }
})
