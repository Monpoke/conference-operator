import { remaining, time } from '@cloudnord/format'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useActionsStore } from './actions.js'
import { useRoomStore } from './room.js'

/**
 * Past this, a start stops being "a little early" and becomes a targeting error.
 *
 * A quarter of an hour: that is the program's widest gap, and therefore the limit
 * below which starting the next talk is a normal gesture — one finished early,
 * the speaker is plugged in, the room is full. Beyond it, one is almost always
 * aiming at something other than what one thinks.
 */
export const TOO_EARLY_MS = 15 * 60_000

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

  const session = computed(() => room.payload?.state.targetSession ?? null)

  /**
   * The start settings, defaults included.
   *
   * The defaults live in the contract, where the hub applies them. The page
   * repeats them for a state received before that setting: reading a missing
   * field as "do nothing" would silently disable a guard, which is exactly what
   * it is meant to prevent. A null value, on the other hand, stays an explicit
   * choice.
   */
  const settings = computed(() => {
    const config = room.payload?.diagnostics?.config
    return {
      warn: config?.promptRecordingOnStart !== false,
      warnOnStop: config?.promptRecordingOnStop !== false,
      scene: config?.sceneOnStart === undefined ? 'LIVE' : config.sceneOnStart,
    }
  })

  /** How early against the slot, or `null` with no talk to drive. */
  const earlyByMs = computed(() =>
    session.value == null ? null : session.value.startsAtMs - room.now,
  )

  /** What is left of the slot, or `null` on a slot with no end time. */
  const leftMs = computed(() =>
    session.value?.endsAtMs == null ? null : session.value.endsAtMs - room.now,
  )

  /** What OBS-B is really doing, observed and not assumed. */
  const recording = computed(() => room.payload?.diagnostics?.recording?.active === true)

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

  /** First guard: is this really the talk being aimed at? */
  function askStart(): void {
    const early = earlyByMs.value
    if (early == null || early <= TOO_EARLY_MS) {
      void start()
      return
    }
    tooEarlyOpen.value = true
  }

  /** Second guard: the VOD, which cannot be made good in the evening. */
  async function start(): Promise<void> {
    tooEarlyOpen.value = false
    if (settings.value.warn && !recording.value) {
      // The question only makes sense beforehand: once the talk has started, a
      // recording begun now will always miss the first few minutes.
      recordingOpen.value = true
      return
    }
    await launch(false)
  }

  /** @param record Start the recording first, then the talk. */
  async function launch(record: boolean): Promise<void> {
    recordingOpen.value = false
    if (record) {
      const result = await actions.act({ action: 'recording.start' })
      // The recording first, and only if it starts: beginning anyway would make
      // the warning a lie the next time round.
      if (!result.ok) return
    }
    await actions.act({ action: 'session.start' })

    // After the start: the scene follows the talk, and a switch with no talk
    // started would leave the room on air over nothing.
    const role = settings.value.scene
    if (role) await actions.act({ action: 'scene.set', role })
  }

  /**
   * Ending, with a guard when it is early.
   *
   * Early only: ending on time or in overrun is the day's normal gesture, and
   * confirming it every time would turn it into a reflex. A slot with no end time
   * cannot be early — nothing to ask.
   */
  function askEnd(): void {
    const left = leftMs.value
    if (left == null || left <= 0) {
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
    if (settings.value.warnOnStop && recording.value) {
      stopRecordingOpen.value = true
      return
    }
    await finish(false)
  }

  /** @param stop Stop the take first, then end the talk. */
  async function finish(stop: boolean): Promise<void> {
    stopRecordingOpen.value = false
    if (stop) {
      const result = await actions.act({ action: 'recording.stop' })
      // The stop first, and only if it succeeds: ending anyway would leave the
      // take running with nothing ever raising it again.
      if (!result.ok) return
    }
    await actions.act({ action: 'session.end' })
  }

  /** Putting it back as upcoming, when "Terminer" was a mistake. */
  async function reset(): Promise<void> {
    await actions.act({ action: 'session.reset' })
  }

  return {
    tooEarlyOpen,
    recordingOpen,
    endEarlyOpen,
    stopRecordingOpen,
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
  }
})
