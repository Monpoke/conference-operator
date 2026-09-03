/**
 * Lifecycle of a talk: the only state of the day that is a decision.
 *
 * `scheduled` is never written — we only record what happened, and the absence
 * of a row *is* the default state. So the table below says what you are allowed
 * to do from each state, not what gets stored.
 *
 * It lives here, and not in the hub that writes nor in the control app that
 * commands, because both already knew it separately: the control app greyed out
 * `End` on a talk that had not been launched while the hub's procedure accepted
 * it without blinking. Two places for one rule is one place too many — and the
 * one you forget is the one that decides on the day.
 */

export const SESSION_STATUSES = ['scheduled', 'running', 'ended'] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

/** The three possible gestures on a talk. */
export const SESSION_ACTIONS = ['start', 'end', 'reset'] as const
export type SessionAction = (typeof SESSION_ACTIONS)[number]

/**
 * Status reached by an action, or `null` when the action makes no sense from
 * that state.
 *
 * Two choices are worth spelling out.
 *
 * `start` stays open from `ended`: an automatic close that lands on a talk that
 * was not finished must be recoverable in one gesture, without going through
 * "Back to upcoming". Refusing it would force the operator into two clicks at
 * the worst moment of the day.
 *
 * `reset` is allowed from everywhere, including `running`. It is the escape
 * hatch: it only serves to repair a slip, and a conditional escape hatch is not
 * one. The UI only offers it today on an ended talk, but that is a surface
 * choice, not a domain rule.
 */
const TRANSITIONS: Record<
  SessionStatus,
  Record<SessionAction, SessionStatus | null>
> = {
  scheduled: { start: 'running', end: null, reset: 'scheduled' },
  running: { start: null, end: 'ended', reset: 'scheduled' },
  ended: { start: 'running', end: null, reset: 'scheduled' },
}

/**
 * What a talk becomes, or `null` if the gesture is refused.
 *
 * `statusAfter('running', 'start')` is `null`: the talk is already running.
 */
export function statusAfter(
  from: SessionStatus,
  action: SessionAction,
): SessionStatus | null {
  return TRANSITIONS[from][action]
}

export function isTransitionAllowed(
  from: SessionStatus,
  action: SessionAction,
): boolean {
  return TRANSITIONS[from][action] != null
}

/**
 * Why the gesture is refused, in one sentence meant for the operator.
 *
 * Returns `null` when it is not. The message states the observed state rather
 * than the rule broken: in the control room, "already launched" is understood
 * straight away, "forbidden transition" means going off to read a table.
 */
export function transitionRefusal(
  from: SessionStatus,
  action: SessionAction,
): string | null {
  if (isTransitionAllowed(from, action)) return null
  if (action === 'start') return 'Cette conférence est déjà lancée.'
  return from === 'ended'
    ? 'Cette conférence est déjà terminée.'
    : "Cette conférence n'a pas été lancée : il n'y a rien à terminer."
}

/**
 * A decision taken *after* the instant we are looking at does not apply.
 *
 * It belongs to a day that has not happened yet — which only occurs with a
 * simulated clock, when you wind it back to replay a moment. The talk launched
 * during an 11:00 rehearsal must not be "running" when you go back to 08:38:
 * nobody had started it at that hour.
 *
 * We filter **on read** rather than erasing the decision: winding the clock
 * forward again must find the day exactly where it was left. Under a real
 * clock, the rule is never visible — no decision is dated in the future.
 *
 * An unreadable date stays applicable: a state we cannot place in time is a
 * data problem, not a reason to make it disappear.
 */
export function isDecisionApplicable(decidedAtMs: number | null | undefined, nowMs: number): boolean {
  if (decidedAtMs == null || Number.isNaN(decidedAtMs)) return true
  return decidedAtMs <= nowMs
}
