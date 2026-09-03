/**
 * Values come from the `selectors` subpath, not from the package root.
 *
 * The root re-exports the program's zod schemas: the browser bundle used to
 * embed them *whole*, six hundred kilobytes inlined into every page for three
 * scheduling functions. The subpath exposes pure computation only.
 */
import {
  effectiveEndMs,
  sessionsForRoom,
  timelinePosition,
  type ScheduledSession,
} from '@cloudnord/program/selectors'
import type { Program, Session } from '@cloudnord/program'
import type { SessionStatus } from './lifecycle.js'

/**
 * What a slot needs to carry for us to tell where a room stands.
 *
 * Narrower than `Session`, and that is what lets the state machine run on both
 * sides: the hub feeds it whole sessions, the control app feeds it slots read
 * back from its cache, and nobody has to fabricate a title or a speaker list to
 * ask a scheduling question.
 */
export type Slot = ScheduledSession & Pick<Session, 'id' | 'kind'>

/**
 * Where a room stands, in one word. See `stateOfSlots`.
 *
 * The list is a constant and not just a type: the oRPC contract derives its
 * `z.enum` from it, so a state added here travels the wire without being
 * rewritten anywhere else. The two lists used to exist separately, and nothing
 * would have flagged that they had stopped saying the same thing.
 *
 * The values themselves stay French: they are wire values, stored and exchanged
 * with rooms already in the field.
 */
export const ROOM_STATES = [
  'aucune',
  'pause',
  'pas-commencee',
  'retard',
  'en-cours',
  'fin-proche',
  'terminee',
  'depassement',
] as const

export type RoomConferenceState = (typeof ROOM_STATES)[number]

/** Below this, a talk is "ending soon": the moment a decision gets made. */
export const ENDING_SOON_MS = 5 * 60_000

/**
 * Beyond this, a started slot nobody launched becomes a delay.
 *
 * The first few minutes say nothing: the audience is settling in, the speaker
 * is plugging in a laptop. It is after that the missing start becomes a
 * question.
 */
export const LATE_MS = 5 * 60_000

/**
 * Below this, an approaching break is announced.
 *
 * A quarter of an hour: the moment you stop launching anything and start
 * preparing what comes after. Earlier, the information is of no use; later, it
 * arrives after the decision it was meant to inform.
 */
export const BREAK_SOON_MS = 15 * 60_000

/** Lifecycle of a room's talks, by identifier. */
export type SessionStatuses = Record<string, SessionStatus>

/** Effective end of the slot at `index` in an already sorted sequence. */
export function effectiveEndAt(slots: readonly ScheduledSession[], index: number): number | null {
  const slot = slots[index]
  return slot == null ? null : effectiveEndMs(slot, slots[index + 1])
}

/**
 * Room state as the consoles paint it.
 *
 * Crosses two sources that say different things:
 *
 * - **the program** gives the slot: what *should* be playing, at `nowMs`;
 * - **the lifecycle** (`Start` / `End` in the control app) gives what is really
 *   playing. It alone reveals an **overrun** — the program, past the end time,
 *   simply moves to the next slot — and it alone tells a running talk apart
 *   from a slot nobody launched.
 *
 * Without a lifecycle, a room shows up as "not started" then "late" all the way
 * through. That is accepted: the console cannot guess a talk is running if
 * nobody says so, and the word next to the status dot keeps that absence from
 * reading as a failure.
 */
export function stateOfSlots(
  slots: readonly Slot[],
  nowMs: number,
  statuses: SessionStatuses = {},
): RoomConferenceState {
  /**
   * Overrun first: it is the only state that speaks of a *past* slot, and the
   * only one that shifts the rest of the day.
   */
  const overrunning = slots.some((slot, index) => {
    if (statuses[slot.id] !== 'running') return false
    /**
     * A slot that is not a talk cannot overrun.
     *
     * There is nothing to end there — nobody closes a lunch break —, and a
     * "running" state may be left over from before: the hub serves the program
     * with decisions included, and a talk already launched can be declared a
     * break during the day. Flagging it as an overrun would make the console
     * blink over a fact we have just corrected ourselves.
     */
    if (slot.kind === 'break') return false
    const end = effectiveEndAt(slots, index)
    return end != null && end <= nowMs
  })
  if (overrunning) return 'depassement'

  const { current } = timelinePosition(slots as Slot[], nowMs)
  if (current == null) return 'aucune'
  if (current.kind === 'break') return 'pause'

  const status = statuses[current.id] ?? 'scheduled'
  // Ended ahead of time: the room is free, and that is information for the room
  // next door — not an empty slot.
  if (status === 'ended') return 'terminee'

  if (status === 'running') {
    const end = effectiveEndAt(slots, slots.indexOf(current))
    return end != null && end - nowMs <= ENDING_SOON_MS ? 'fin-proche' : 'en-cours'
  }
  return nowMs - current.startsAtMs > LATE_MS ? 'retard' : 'pas-commencee'
}

/**
 * What the program alone says, without the lifecycle.
 *
 * Four states out of eight. The other four — not started, late, ended, overrun
 * — hinge on operator decisions, and a client that does not receive them must
 * never guess: the control app only receives the lifecycle of its own room.
 * During an outage, calling the room next door "late" because the news never
 * arrived would be a false alarm, at the exact moment nobody can check.
 *
 * So we describe the slot, not the room — and the word shown next to the status
 * dot says which of the two we are looking at.
 */
export function stateFromProgram(
  slots: readonly Slot[],
  nowMs: number,
): RoomConferenceState {
  const { current } = timelinePosition(slots as Slot[], nowMs)
  if (current == null) return 'aucune'
  if (current.kind === 'break') return 'pause'
  const end = effectiveEndAt(slots, slots.indexOf(current))
  return end != null && end - nowMs <= ENDING_SOON_MS ? 'fin-proche' : 'en-cours'
}

export interface Break<T> {
  /** `en-cours`: the break is running. `a-venir`: it starts within a quarter of an hour. */
  state: 'en-cours' | 'a-venir'
  session: T
  /** Resumption: effective end of the break, or `null` if nothing closes it. */
  endsAtMs: number | null
}

export type RoomBreak = Break<Session>

/**
 * A room's break, running or imminent.
 *
 * A separate piece of data from the room state, and not one more state: it
 * coexists with what the room is doing. A talk can run while lunch approaches —
 * that is even the case that matters, the one where you decide not to let it
 * slide.
 *
 * `null` the rest of the time: the badge only shows up when it has something to
 * say.
 */
export function breakOfSlots<T extends Slot>(
  slots: readonly T[],
  nowMs: number,
): Break<T> | null {
  const resumesAt = (slot: T): number | null => effectiveEndAt(slots, slots.indexOf(slot))

  const { current, next } = timelinePosition(slots as T[], nowMs)
  if (current?.kind === 'break') {
    return { state: 'en-cours', session: current, endsAtMs: resumesAt(current) }
  }
  /**
   * The next slot, whether or not a talk is running.
   *
   * That is where the value is: knowing lunch falls in twelve minutes while a
   * talk is wrapping up is what makes you decide not to run straight on. Only
   * looking at rooms that are already empty would have handed the information
   * to those who no longer needed it.
   */
  if (next?.kind === 'break' && next.startsAtMs - nowMs <= BREAK_SOON_MS) {
    return { state: 'a-venir', session: next, endsAtMs: resumesAt(next) }
  }
  return null
}

/**
 * The room's next talk: the one that is still going to happen.
 *
 * Two filters, and the second is the one that was missing.
 *
 * **Breaks** first: lunch is not what you are waiting for, and counting down to
 * it would give a number that is correct and useless when what is being
 * prepared is the talk after it.
 *
 * Talks **already ended** next. The control app allows `Start` — then `End` —
 * on a talk whose slot has not begun yet; that one then stayed "after now", and
 * the room designated itself as its own next talk: the big countdown counted
 * down to the start of a talk that had just been closed, and the detail line
 * announced "next talk at 09:50" on the 09:50 talk that had just been ended. An
 * ended talk is no longer going to happen.
 */
export function nextTalk<T extends Slot>(
  slots: readonly T[],
  nowMs: number,
  statuses: SessionStatuses = {},
): T | null {
  return (
    slots.find(
      (slot) =>
        slot.kind === 'talk' &&
        slot.startsAtMs > nowMs &&
        statuses[slot.id] !== 'ended',
    ) ?? null
  )
}

/**
 * The talk the control app drives: the one `Start` and `End` act on.
 *
 * Three rules, in this order, and the order is what carries the meaning.
 *
 * The **current** slot, when it is a talk, first: that is what the room is
 * living through, and it wins even if an older talk was left open for want of
 * an `End`. Without that precedence, forgetting to close the 09:00 talk would
 * make every later one undrivable.
 *
 * A talk **still running** next, even if its slot is past. That is the overrun,
 * and it is precisely when `End` is the button you are looking for: a talk
 * launched at 09:00 for 09:45 still speaking at 09:46 dropped out of the target
 * the second its slot closed — the control app switched to the countdown of the
 * 09:50 talk and the one gesture able to stop what was on air disappeared from
 * the screen. It holds during a break too: a talk overrunning into lunch is
 * still on air, so it stays drivable.
 *
 * The **next one to happen** last, for the ordinary case: between two talks,
 * during a break, before the doors open, what you are preparing is the one
 * coming up.
 *
 * @param statuses Lifecycle as it applies at `nowMs` — that is what tells a talk
 * on air from a slot nobody launched.
 */
export function talkToControl<T extends Slot>(
  slots: readonly T[],
  nowMs: number,
  statuses: SessionStatuses = {},
): T | null {
  const { current } = timelinePosition(slots as T[], nowMs)
  if (current?.kind === 'talk') return current

  /**
   * A **talk**, as everywhere else here.
   *
   * A break and a hollow slot are not driven: there is nothing to start or end
   * in a room having lunch. A slot the upstream export calls a break and that
   * has to be driven — a keynote with no speaker, say — is declared a talk from
   * the console, and it is that decision which makes it drivable, not the fact
   * of having launched it.
   *
   * The **last** one launched, not the first one found: two talks can carry
   * `running` at the same time — one left open in the morning, the other
   * launched since. The one on air is the later one in the program.
   */
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    const slot = slots[index]!
    if (slot.kind === 'talk' && statuses[slot.id] === 'running') return slot
  }

  return nextTalk(slots, nowMs, statuses)
}

/**
 * The scheduling rule: when an overrunning slot closes by itself.
 *
 * It exists because nobody thinks of pressing `End` when a talk overruns and
 * the room is applauding. The grace period is configurable: five minutes suit a
 * 50-minute format, far less a 20-minute lightning talk.
 */
export interface AutoEndSetting {
  enabled: boolean
  graceMinutes: number
}

export const DEFAULT_AUTO_END: AutoEndSetting = { enabled: true, graceMinutes: 5 }

/**
 * Should this talk be closed by the scheduling rule?
 *
 * `end` is the slot's **effective end** — explicit time, else duration, else
 * start of the next slot. That is exactly the end the overrun rests on, and
 * that is the point: the two rules used to speak of different times, so a slot
 * whose export only gives a start time went into overrun without the sweep ever
 * seeing it. The room stayed red for the rest of the day, and nothing but an
 * operator could get it out.
 *
 * Two refusals remain, each for its own reason.
 *
 * - **Not running**: a talk never started stays "upcoming". Claiming a talk took
 *   place when nobody launched it would be a lie in the history, and would skew
 *   the VOD.
 * - **Unknown end** (`null`): slot missing from the program after a reimport, or
 *   last slot of a day that none of the three rules closes. With no reference
 *   time, we decide nothing — and a room staying in overrun on that basis is
 *   right to say so: nobody knows when it ends.
 */
export function shouldAutoEnd(
  end: number | null,
  status: SessionStatus,
  nowMs: number,
  setting: AutoEndSetting = DEFAULT_AUTO_END,
): boolean {
  if (!setting.enabled) return false
  if (status !== 'running') return false
  if (end == null) return false
  return end <= nowMs - setting.graceMinutes * 60_000
}

/**
 * The slots of a room the scheduling rule must close at this instant.
 *
 * Takes a list, like everything else here: a slot's effective end depends on the
 * one that follows it, and that is exactly what the per-slot version could not
 * see.
 */
export function toAutoEnd<T extends Slot>(
  slots: readonly T[],
  nowMs: number,
  statuses: SessionStatuses = {},
  setting: AutoEndSetting = DEFAULT_AUTO_END,
): T[] {
  return slots.filter((slot, index) =>
    shouldAutoEnd(effectiveEndAt(slots, index), statuses[slot.id] ?? 'scheduled', nowMs, setting),
  )
}

/**
 * Effective end of a slot, put back in the context of its room's program.
 *
 * What the hub needs in order to apply the scheduling rule: it starts from a
 * stored decision, not from a list of slots, and has to find the neighbour that
 * closes this one. Returns `null` for a slot the current program no longer
 * holds.
 */
export function effectiveEndInProgram(program: Program, sessionId: string): number | null {
  const session = program.sessions.find((slot) => slot.id === sessionId)
  if (session?.roomId == null) return null
  const slots = sessionsForRoom(program, session.roomId)
  return effectiveEndAt(slots, slots.indexOf(session))
}

/** Where a room of the program stands. Wrapper around `stateOfSlots`. */
export function roomConferenceState(
  program: Program,
  roomId: string,
  nowMs: number,
  statuses: SessionStatuses = {},
): RoomConferenceState {
  return stateOfSlots(sessionsForRoom(program, roomId), nowMs, statuses)
}

/** A program room's break. Wrapper around `breakOfSlots`. */
export function roomBreak(program: Program, roomId: string, nowMs: number): RoomBreak | null {
  return breakOfSlots(sessionsForRoom(program, roomId), nowMs)
}
