/**
 * Starting and ending a talk: what to ask, then what to send, in what order.
 *
 * Shared by every surface that starts a talk — the control app, which asks in
 * dialogs, and the Stream Deck plugin, which asks with a long press. One sequence
 * for both: a guard added here holds on every surface at once, instead of on the
 * one somebody thought of.
 *
 * The order is the heart of the matter. On each side, the question about **the
 * talk** comes before the one about **the take**: "start very early?" before
 * "nothing is recording", "end early?" before "the take is still running". The
 * other way round, one would start a take for a talk one is about to decline to
 * start, and cut the take of a talk one is about to decline to end.
 *
 * Pure: no store, no clock read here — the caller says what time it is and what
 * the room is doing.
 */

/**
 * Past this, a start stops being "a little early" and becomes a targeting error.
 *
 * A quarter of an hour: that is the program's widest gap, and therefore the limit
 * below which starting the next talk is a normal gesture — one finished early,
 * the speaker is plugged in, the room is full. Beyond it, one is almost always
 * aiming at something other than what one thinks.
 */
export const TOO_EARLY_MS = 15 * 60_000

/** What the flow reads of the room — the fields any surface's state carries. */
export interface TalkFlowInput {
  /** The room's corrected time, in ms. */
  nowMs: number
  /** The talk the room aims at (`targetSession`), or `null` with nothing to drive. */
  target: { id: string; startsAtMs: number; endsAtMs: number | null } | null
  /** The talk forced into the room by hand, or `null` when the clock decides. */
  pinnedSessionId: string | null
  /** What OBS-B is really doing, observed and not assumed. */
  recording: boolean
  /** The room's start settings, as configured (`diagnostics.config`). */
  config?: {
    promptRecordingOnStart?: boolean
    promptRecordingOnStop?: boolean
    sceneOnStart?: string | null
  } | null
}

/** A gesture for the room, as `POST /control/action` takes it. */
export type TalkGesture = { action: string } & Record<string, unknown>

/** One step of a sequence. `guard`: if it fails, the steps after it do not go. */
export interface TalkStep {
  gesture: TalkGesture
  guard: boolean
}

/**
 * The start settings, defaults included.
 *
 * The defaults live in the contract, where the hub applies them; repeated here
 * for a state received before the setting existed. Reading a missing field as
 * "do nothing" would silently disable a guard, which is exactly what it is meant
 * to prevent. A null scene, on the other hand, stays an explicit choice.
 */
export function talkSettings(config: TalkFlowInput['config']): {
  warn: boolean
  warnOnStop: boolean
  scene: string | null
} {
  return {
    warn: config?.promptRecordingOnStart !== false,
    warnOnStop: config?.promptRecordingOnStop !== false,
    scene: config?.sceneOnStart === undefined ? 'LIVE' : config.sceneOnStart,
  }
}

/** How early against the slot, or `null` with no talk to drive. */
export function earlyByMs(input: TalkFlowInput): number | null {
  return input.target == null ? null : input.target.startsAtMs - input.nowMs
}

/** What is left of the slot, or `null` on a slot with no end time. */
export function leftMs(input: TalkFlowInput): number | null {
  return input.target?.endsAtMs == null ? null : input.target.endsAtMs - input.nowMs
}

/**
 * First start guard: is this really the talk being aimed at?
 *
 * A forced talk has already answered it: someone picked it from the list and
 * pressed "Forcer maintenant". Asking again whether it is early would put the
 * same question twice to the one person who knows it best.
 */
export function startTooEarly(input: TalkFlowInput): boolean {
  const early = earlyByMs(input)
  const forced = input.pinnedSessionId != null && input.pinnedSessionId === input.target?.id
  return !forced && early != null && early > TOO_EARLY_MS
}

/**
 * Second start guard: the VOD, which cannot be made good in the evening.
 *
 * Only beforehand: once the talk has started, a recording begun now will always
 * miss the first few minutes.
 */
export function startAsksRecording(input: TalkFlowInput): boolean {
  return talkSettings(input.config).warn && !input.recording
}

/**
 * The start, step by step.
 *
 * @param record Start the recording first — and only go on if it starts:
 *   beginning anyway would make the warning a lie the next time round.
 *
 * The scene comes after the start: it follows the talk, and a switch with no talk
 * started would leave the room on air over nothing.
 */
export function startSteps(input: TalkFlowInput, record: boolean): TalkStep[] {
  const steps: TalkStep[] = []
  if (record) steps.push({ gesture: { action: 'recording.start' }, guard: true })
  steps.push({ gesture: { action: 'session.start' }, guard: false })
  const scene = talkSettings(input.config).scene
  if (scene) steps.push({ gesture: { action: 'scene.set', role: scene }, guard: false })
  return steps
}

/**
 * First end guard: ending early.
 *
 * Early only: ending on time or in overrun is the day's normal gesture, and
 * confirming it every time would turn it into a reflex. A slot with no end time
 * cannot be early.
 */
export function endEarly(input: TalkFlowInput): boolean {
  const left = leftMs(input)
  return left != null && left > 0
}

/**
 * Second end guard: the take still running.
 *
 * Bar the stop, a forgotten take is visible nowhere: the indicator says
 * "recording" as it did during the talk, and the price — the next talk written
 * into the same file — is only discovered at editing time.
 */
export function endAsksStopRecording(input: TalkFlowInput): boolean {
  return talkSettings(input.config).warnOnStop && input.recording
}

/**
 * The end, step by step.
 *
 * @param stop Stop the take first — and only go on if it stops: ending anyway
 *   would leave the take running with nothing ever raising it again.
 */
export function endSteps(stop: boolean): TalkStep[] {
  const steps: TalkStep[] = []
  if (stop) steps.push({ gesture: { action: 'recording.stop' }, guard: true })
  steps.push({ gesture: { action: 'session.end' }, guard: false })
  return steps
}

/**
 * Plays the steps in order; a failed guard stops the rest.
 *
 * @returns whether every guard held.
 */
export async function runTalkSteps(
  steps: TalkStep[],
  act: (gesture: TalkGesture) => Promise<{ ok: boolean }>,
): Promise<boolean> {
  for (const step of steps) {
    const result = await act(step.gesture)
    if (step.guard && !result.ok) return false
  }
  return true
}
