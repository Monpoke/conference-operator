import type { DisplayPayload } from '@conference-operator/contract'
import { nextTalk } from '@conference-operator/room-state'

/**
 * What the large stopwatch counts.
 *
 * Before the slot, the time left **before** starting; from its hour on, what is
 * left of the slot. Counting towards the end from the outset gave "2:01:59" in
 * large type at 8:38 on the 9:50 talk: a figure that reads as a talk under way,
 * and that was read that way.
 *
 * A talk started early counts towards its end without waiting for its hour: once
 * "Commencer" has been pressed, it is the gap against the program that decides
 * the rest of the day.
 *
 * Outside any component, because it is a rule and not a rendering: it can be
 * checked on chosen instants, without mounting anything.
 */
export interface Countdown {
  ms: number
  /** The countdown aims at a start, not an end. The badge says so beside the number. */
  beforeStart: boolean
}

export function countdownFor(payload: DisplayPayload, atMs: number): Countdown | null {
  const session = payload.state.targetSession
  if (session == null) return null
  const status = payload.state.sessionStates?.[session.id] ?? 'scheduled'

  /*
   * An ended talk counts nothing down any more.
   *
   * The stopwatch used to carry on over its slot: "Terminer" pressed at 10:35,
   * and fifteen minutes were left on screen for a talk the room had just left.
   * What one comes looking for at that moment is the only thing that decides
   * what follows — how long until the next one starts.
   */
  if (status === 'ended') {
    const next = nextTalkFor(payload, atMs)
    return next == null ? null : { ms: next.startsAtMs - atMs, beforeStart: true }
  }

  if (status === 'scheduled' && session.startsAtMs > atMs) {
    return { ms: session.startsAtMs - atMs, beforeStart: true }
  }
  return session.endsAtMs == null ? null : { ms: session.endsAtMs - atMs, beforeStart: false }
}

/**
 * The room's next talk: the one that will still take place.
 *
 * Breaks skipped — a lunch is not what one is waiting for — and already ended
 * talks skipped too. The rule is the state machine's, the same one the test
 * bench runs through; the page does not decide for itself.
 */
export function nextTalkFor(
  payload: DisplayPayload,
  atMs: number,
): DisplayPayload['sessions'][number] | null {
  return nextTalk(payload.sessions ?? [], atMs, payload.state.sessionStates ?? {})
}

/**
 * The time that should be left according to the program.
 *
 * Not the time elapsed since the real start: it is the gap against the scheduled
 * slot that counts, because that is what shifts the rest of the day.
 */
export function scheduleGapMs(payload: DisplayPayload, atMs: number): number | null {
  const session = payload.state.targetSession
  if (session?.endsAtMs == null) return null
  return session.endsAtMs - atMs
}
