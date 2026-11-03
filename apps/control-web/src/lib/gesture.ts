import type { DisplayPayload } from '@conference-operator/contract'

/** Within this lead, a scheduled talk is the gesture to make: the speaker is settling in. */
export const START_LEAD_MS = 5 * 60_000

const statusOf = (payload: DisplayPayload): string => {
  const session = payload.state.targetSession
  return session == null ? 'none' : (payload.state.sessionStates?.[session.id] ?? 'scheduled')
}

/**
 * How late the room's own talk is, or `null` when it is not.
 *
 * The rooms strip already tells every other room this one is « retard au
 * démarrage »; the panel driving it has to say it too, in the same words.
 */
export function lateStartMs(payload: DisplayPayload, atMs: number): number | null {
  const session = payload.state.targetSession
  if (session == null || statusOf(payload) !== 'scheduled') return null
  const late = atMs - session.startsAtMs
  return late >= 60_000 ? late : null
}

export type Gesture = 'start' | 'record' | 'end'

/**
 * The one gesture the room needs now, or none.
 *
 * In a dark room the eye needs a single target: this decides which button gets
 * the primary weight, from the state and never from a click.
 */
export function primaryGesture(payload: DisplayPayload, atMs: number): Gesture | null {
  const session = payload.state.targetSession
  if (session == null) return null
  const status = statusOf(payload)
  if (status === 'scheduled') return session.startsAtMs - atMs <= START_LEAD_MS ? 'start' : null
  if (status !== 'running') return null
  if (payload.diagnostics != null && payload.diagnostics.recording?.active !== true) return 'record'
  return session.endsAtMs != null && atMs > session.endsAtMs ? 'end' : null
}

/**
 * Watched microphones muted on the capture while a talk is due or running.
 *
 * The machine's watchdog only speaks once a take runs; a microphone muted before
 * « Enregistrer » is a VOD lost from its first word, and nothing said so.
 * Inputs the watchdog already reports are left to it.
 */
export function mutedBeforeTake(payload: DisplayPayload, atMs: number): string[] {
  const session = payload.state.targetSession
  if (session == null) return []
  const status = statusOf(payload)
  const due = status === 'running' || (status === 'scheduled' && session.startsAtMs - atMs <= START_LEAD_MS)
  if (!due) return []
  const watched = payload.diagnostics?.config?.microSurveille ?? null
  const reported = new Set((payload.state.audioAlerts ?? []).map((alert) => alert.input))
  return (payload.state.audioInputs ?? [])
    .filter((input) => watched == null || input.name === watched)
    .filter((input) => (input.muted.B ?? input.muted.A) === true)
    .map((input) => input.name)
    .filter((name) => !reported.has(name))
}
