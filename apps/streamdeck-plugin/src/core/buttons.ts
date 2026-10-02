import type { DisplayPayload } from '@conference-operator/contract/room-display'
import {
  earlyByMs,
  endAsksStopRecording,
  endSteps,
  startAsksRecording,
  startSteps,
  startTooEarly,
  type TalkFlowInput,
  type TalkStep,
} from '@conference-operator/room-state/talk-flow'

/**
 * What each kind of button shows, and what it sends — as pure functions.
 *
 * The SDK layer only paints `face` and posts `gesture`: everything that decides
 * lives here, testable without a Stream Deck. A button reads the same state the
 * control app reads, so it lights up for what the room really does — a scene
 * switched from the control app or from the hub lights the matching key too.
 */

/** A button's look: its title, whether it is "on" (state 1), and whether the room answers at all. */
export interface ButtonFace {
  title: string
  on: boolean
  offline: boolean
}

/** A press: short, or held past `LONG_PRESS_MS`. */
export type Press = 'short' | 'long'

/**
 * How long the gestures that cannot be undone ask to be held.
 *
 * Stopping the recording, ending the talk, cutting the stream: a key brushed in a
 * dark room must not cost a VOD or the live stream. A second is long enough to be
 * deliberate and short enough to do without thinking.
 */
export const LONG_PRESS_MS = 1_000

/**
 * What a press asks for: a gesture for the room, a sequence of them — the
 * talk's start or end, the control app's very steps — or a hint to show instead.
 */
export type Decision = { gesture: Record<string, unknown> } | { steps: TalkStep[] } | { hint: string } | null

/**
 * The room as the shared talk flow reads it (`room-state/talk-flow`): the same
 * guards and the same steps as the control app's "Commencer" and "Terminer".
 */
export function flowOf(payload: DisplayPayload, nowMs: number): TalkFlowInput {
  const target = payload.state.targetSession
  return {
    nowMs: nowMs + (payload.state.serverTimeOffsetMs ?? 0),
    target: target == null ? null : { id: target.id, startsAtMs: target.startsAtMs, endsAtMs: target.endsAtMs ?? null },
    pinnedSessionId: payload.state.pinnedSessionId ?? null,
    recording: payload.diagnostics?.recording?.active === true,
    config: payload.diagnostics?.config ?? null,
  }
}

/** `1 h 05` / `12 min` — how early, on a key. */
function early(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}` : `${minutes} min`
}

export type ButtonSettings =
  | { kind: 'scene'; role?: string }
  | { kind: 'scene-toggle'; a?: string; b?: string }
  | { kind: 'display'; mode?: string }
  | { kind: 'recording' }
  | { kind: 'mark'; mark?: 'debut' | 'fin' | 'chapitre' }
  | { kind: 'stream' }
  | { kind: 'mic'; input?: string }
  | { kind: 'session'; which?: 'start' | 'start-norec' | 'end' }
  | { kind: 'message-clear' }
  | { kind: 'status' }

const OFFLINE: ButtonFace = { title: 'hors\nligne', on: false, offline: true }

/** `12:04` — elapsed time, as read on a key from a metre away. */
export function elapsed(fromMs: number, nowMs: number): string {
  const total = Math.max(0, Math.floor((nowMs - fromMs) / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

/** Short enough for a 72-pixel key: a word or two per line, three lines at most. */
function fit(text: string, width = 9, lines = 3): string {
  const words = text.split(/\s+/).filter(Boolean)
  const out: string[] = []
  let line = ''
  for (const word of words) {
    if (line === '') line = word
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`
    else {
      out.push(line)
      line = word
    }
  }
  if (line !== '') out.push(line)
  const kept = out.slice(0, lines)
  if (out.length > lines) kept[lines - 1] = `${kept[lines - 1]!.slice(0, width - 1)}…`
  return kept.join('\n')
}

const MARK_LABELS = { debut: 'Début', fin: 'Fin', chapitre: 'Chapitre' } as const

/**
 * The OBS-A scene roles, named as the control app's Projection panel names them —
 * "Direct" and "Habillage" there, so here too: the operator must find on the key
 * the word they press in the control app.
 */
export const SCENE_LABELS: Record<string, string> = {
  LIVE: 'Direct',
  HOLD: 'Habillage',
  TALK: 'Talk',
  CAM_ONLY: 'Caméra',
  SLIDES_ONLY: 'Slides',
  RELAY: 'Relais',
}

/** The room screen's modes, as the control app names them. */
export const DISPLAY_LABELS: Record<string, string> = {
  loop: 'Boucle',
  sponsors: 'Sponsors',
  programme: 'Programme',
  agenda: 'Agenda',
  feedback: 'Notez le talk',
  question: 'Question choisie',
  countdown: 'Compte à rebours',
  message: 'Message',
  wall: 'Mur & questions',
  wallsio: 'Mur social',
  live: 'Live',
}

function muted(payload: DisplayPayload, input: string): boolean | null {
  const source = payload.state.audioInputs?.find((candidate) => candidate.name === input)
  if (source == null) return null
  return source.muted.A === true || source.muted.B === true
}

export function faceOf(
  settings: ButtonSettings,
  payload: DisplayPayload | null,
  nowMs: number,
): ButtonFace {
  if (payload == null) return OFFLINE
  const { state } = payload
  const recording = payload.diagnostics?.recording ?? null
  switch (settings.kind) {
    case 'scene':
      return {
        title: fit(settings.role == null ? 'Scène ?' : (SCENE_LABELS[settings.role] ?? settings.role)),
        on: settings.role != null && state.sceneRole === settings.role,
        offline: false,
      }
    case 'scene-toggle': {
      const [a, b] = togglePair(settings)
      const current = state.sceneRole
      const label = (role: string) => SCENE_LABELS[role] ?? role
      return {
        // What is on air, said plainly; anything else on air — a relay — shows both.
        title: current === a || current === b ? fit(label(current)) : `${label(a)}\n/ ${label(b)}`,
        on: current === a,
        offline: false,
      }
    }
    case 'display':
      return {
        title: fit(settings.mode == null ? 'Écran ?' : (DISPLAY_LABELS[settings.mode] ?? settings.mode)),
        on: settings.mode != null && state.mode === settings.mode,
        offline: false,
      }
    case 'recording':
      return {
        title: state.recording
          ? `REC\n${recording?.startedAtMs != null ? elapsed(recording.startedAtMs, nowMs) : ''}`.trim()
          : 'Enreg.',
        on: state.recording,
        offline: false,
      }
    case 'mark': {
      const mark = settings.mark ?? 'chapitre'
      const editing = recording?.editing ?? null
      const set = mark === 'debut' ? editing?.startMs != null : mark === 'fin' ? editing?.endMs != null : false
      return {
        title: mark === 'chapitre' && recording != null ? `${MARK_LABELS[mark]}\n${recording.markers}` : MARK_LABELS[mark],
        on: set,
        offline: false,
      }
    }
    case 'stream':
      return { title: state.streaming ? 'EN\nDIRECT' : 'Direct', on: state.streaming === true, offline: false }
    case 'mic': {
      const input = settings.input ?? ''
      const isMuted = input === '' ? null : muted(payload, input)
      return {
        title: isMuted == null ? fit(input === '' ? 'Micro ?' : `${input} ?`) : fit(input),
        on: isMuted === true,
        offline: false,
      }
    }
    case 'session': {
      if (settings.which !== 'end' && startTooEarly(flowOf(payload, nowMs))) {
        // Said on the key before the press: the long press is what confirms it.
        return { title: `En avance\n${early(earlyByMs(flowOf(payload, nowMs)) ?? 0)}`, on: false, offline: false }
      }
      const title = (settings.which === 'end' ? state.currentSession : state.targetSession)?.title
      const label = settings.which === 'end' ? 'Terminer' : settings.which === 'start-norec' ? 'Sans enreg.' : 'Démarrer'
      return { title: title == null ? label : `${label}\n${fit(title, 9, 2)}`, on: state.currentSession != null, offline: false }
    }
    case 'message-clear':
      return { title: state.message == null ? 'Aucun\nmessage' : 'Retirer\nmessage', on: state.message != null, offline: false }
    case 'status': {
      const obs = payload.diagnostics?.obs
      const a = obs?.A?.connected === true
      const b = obs?.B == null ? null : obs.B.connected === true
      const hub = state.connectivity === 'ONLINE'
      const mark = (ok: boolean) => (ok ? '✓' : '✗')
      return {
        title: `OBS-A ${mark(a)}${b == null ? '' : `\nOBS-B ${mark(b)}`}\nHub ${mark(hub)}`,
        on: a && b !== false && hub,
        offline: false,
      }
    }
  }
}

/**
 * What a press sends. The risky gestures — stop the recording, end the talk, cut
 * the stream — only go on a long press; a short one shows how to do it instead.
 */
export function decide(
  settings: ButtonSettings,
  payload: DisplayPayload | null,
  press: Press,
  nowMs: number = Date.now(),
): Decision {
  if (payload == null) return { hint: 'Poste de salle injoignable' }
  const { state } = payload
  const hold = (gesture: Record<string, unknown>, what: string): Decision =>
    press === 'long' ? { gesture } : { hint: `Maintenir pour ${what}` }

  switch (settings.kind) {
    case 'scene':
      return settings.role == null ? { hint: 'Choisir une scène' } : { gesture: { action: 'scene.set', role: settings.role } }
    case 'scene-toggle': {
      // The other one than what is **really** on air — not what this key last sent:
      // a switch made from the control app must not leave the key one step behind.
      const [a, b] = togglePair(settings)
      return { gesture: { action: 'scene.set', role: state.sceneRole === a ? b : a } }
    }
    case 'display':
      return settings.mode == null ? { hint: 'Choisir un écran' } : { gesture: { action: 'display.set', mode: settings.mode } }
    case 'recording':
      return state.recording ? hold({ action: 'recording.stop' }, "arrêter l'enregistrement") : { gesture: { action: 'recording.start' } }
    case 'mark': {
      const mark = settings.mark ?? 'chapitre'
      return {
        gesture: { action: 'recording.mark', label: MARK_LABELS[mark], role: mark === 'chapitre' ? null : mark },
      }
    }
    case 'stream':
      return state.streaming ? hold({ action: 'stream.stop' }, 'couper le direct') : { gesture: { action: 'stream.start' } }
    case 'mic': {
      if (settings.input == null || settings.input === '') return { hint: 'Choisir une source' }
      const isMuted = muted(payload, settings.input)
      if (isMuted == null) return { hint: 'Source inconnue' }
      return { gesture: { action: 'audio.mute', input: settings.input, muted: !isMuted } }
    }
    case 'session': {
      const flow = flowOf(payload, nowMs)
      if (settings.which === 'end') {
        // Always held: ending is the gesture next to starting, and it is final.
        // The take goes with it when the room's guard says so — left running, the
        // next talk would be written into the same file.
        if (press !== 'long') return { hint: 'Maintenir pour terminer la conférence' }
        return { steps: endSteps(endAsksStopRecording(flow)) }
      }
      if (startTooEarly(flow) && press !== 'long') return { hint: 'Maintenir : très en avance' }
      // "Enregistrer et commencer", the control app's safe answer, unless the key
      // was set to start without recording — a choice made beforehand, not a reflex.
      const record = settings.which !== 'start-norec' && startAsksRecording(flow)
      return { steps: startSteps(flow, record) }
    }
    case 'message-clear':
      return state.message == null ? null : { gesture: { action: 'screen.message.clear' } }
    case 'status':
      return null
  }
}

/** The two scenes a toggle alternates between: Direct and Habillage unless set otherwise. */
function togglePair(settings: { a?: string; b?: string }): [string, string] {
  return [settings.a ?? 'LIVE', settings.b ?? 'HOLD']
}

/** Short or long, from how long the key was held. */
export function pressOf(downAtMs: number, upAtMs: number): Press {
  return upAtMs - downAtMs >= LONG_PRESS_MS ? 'long' : 'short'
}
