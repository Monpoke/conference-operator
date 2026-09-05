import type { ControlDiagnostics, DisplayPayload } from '@conference-operator/contract'
import {
  appearanceOf,
  outlineOf,
  stateFromProgram,
  authoritativeState,
  effectiveEndAt,
  breakOfSlots,
  STALE_VIEW_MS,
} from '@conference-operator/room-state'
import type { Session } from '@conference-operator/program'
import { timelinePosition } from '@conference-operator/program/selectors'
import { duration, time } from '@conference-operator/format'

/** What the hub knows of a room, or `null` if its view does not have it yet. */
export function hubView(
  payload: DisplayPayload,
  roomId: string,
): ControlDiagnostics['rooms'][number] | null {
  return (payload.diagnostics?.rooms ?? []).find((room) => room.roomId === roomId) ?? null
}

/**
 * A room's state: the local program, except for what it alone cannot know.
 *
 * The adjudication — which states only the hub knows, and up to what freshness
 * its view is authoritative — lives in the library, with the computation it
 * adjudicates. All we bring here is what we alone have: the date of the last
 * refresh.
 */
export function roomState(
  payload: DisplayPayload,
  roomId: string,
  sessions: Session[],
  atMs: number,
): { fill: string; word: string; text: string } {
  const local = stateFromProgram(sessions, atMs)
  const view = hubView(payload, roomId)
  const refreshed = payload.diagnostics?.roomsRefreshedAt
  const fresh = refreshed != null && Date.now() - Date.parse(refreshed) < STALE_VIEW_MS
  const name = authoritativeState(local, view?.conference, fresh)

  /*
   * Program missing from the cache: say so.
   *
   * "hors créneau" would read as a room with nothing scheduled, when in fact we
   * know nothing at all about its schedule.
   */
  if (name === 'aucune' && sessions.length === 0) {
    return { fill: 'off', word: 'programme inconnu', text: 'text-dim' }
  }
  const looks = appearanceOf(name)
  return { fill: looks.tint, word: looks.word, text: looks.text }
}

/** One cell of the header strip: everything it displays, already decided. */
export interface RoomStripEntry {
  id: string
  name: string
  dot: string
  /** The title of what is playing there, or empty when the title is not what counts. */
  label: string
  detail: string
  tint: string
  breakTag: { text: string; tint: string } | null
}

/**
 * The other rooms, seen from the two sources that speak of them.
 *
 * The program gives the list and the slots even with the hub cut off; the state
 * the hub reports adds connectivity and recording when it is reachable.
 */
export function otherRooms(
  payload: DisplayPayload,
  programRooms: { id: string; name: string }[],
): { id: string; name: string; connectivity?: string }[] {
  const byId = new Map<string, { id: string; name: string; connectivity?: string }>()
  for (const room of programRooms) byId.set(room.id, { id: room.id, name: room.name })
  for (const room of payload.diagnostics?.rooms ?? []) {
    const known = byId.get(room.roomId) ?? { id: room.roomId, name: room.name }
    known.connectivity = room.connectivity
    byId.set(room.roomId, known)
  }
  if (payload.state.roomId != null) byId.delete(payload.state.roomId)
  return [...byId.values()]
}

/**
 * What a neighbouring room shows in the strip.
 *
 * All the strip's logic lives here, outside any component, because it is checked
 * on chosen instants: "en cours · fin 10:45", "vers la fin · 3 min", "reprise
 * 14:00" and "dépassement" are four sentences each of which decides whether the
 * talk next door starts now or in five minutes.
 */
export function stripEntry(
  payload: DisplayPayload,
  room: { id: string; name: string; connectivity?: string },
  sessions: Session[],
  atMs: number,
): RoomStripEntry {
  const view = hubView(payload, room.id)
  const { current, next } = timelinePosition(sessions, atMs)
  const state = roomState(payload, room.id, sessions, atMs)
  const zone = payload.timezone

  let label = ''
  let detail = 'programme inconnu'
  let tint = 'text-dim'

  if (state.fill === 'overrun') {
    // The program has moved on to the next slot; the room has not. The room is
    // right, and that is what shifts the whole day.
    label =
      sessions.find((session) => session.id === view?.currentSessionId)?.title ??
      current?.title ??
      ''
    detail = state.word
    tint = 'text-alert'
  } else if (['late', 'not-started', 'ended'].includes(state.fill)) {
    label = current?.title ?? ''
    detail = state.word
    tint = state.fill === 'late' ? 'text-warn' : 'text-dim'
  } else if (current?.kind === 'break') {
    // No label: the BREAK tag already says it, and "Déjeuner" in place of a talk
    // title read as a busy room. What decides here is the resumption time.
    detail = next == null ? 'pause' : `reprise ${time(next.startsAt, zone)}`
  } else if (current != null) {
    label = current.title
    const end = effectiveEndAt(sessions, sessions.indexOf(current))
    if (state.fill === 'ending-soon') {
      detail = `vers la fin · ${duration(end == null ? 0 : Math.round((end - atMs) / 60000))}`
      tint = 'text-warn'
    } else {
      detail = current.endsAt ? `en cours · fin ${time(current.endsAt, zone)}` : 'en cours'
    }
  } else if (next != null) {
    label = next.title
    detail = `à ${time(next.startsAt, zone)}`
  } else if (sessions.length > 0) {
    detail = 'programme terminé'
  }

  /**
   * The break tag, beside the room's name.
   *
   * It coexists with whatever the room is doing: "BREAK à venir" shows while a
   * talk is still running, and that is where it earns its place.
   */
  const breakSlot = breakOfSlots(sessions, atMs)

  return {
    id: room.id,
    name: room.name,
    dot: `${state.fill}${outlineOf(view?.connectivity ?? room.connectivity)}`.trim(),
    label,
    detail,
    tint,
    breakTag:
      breakSlot == null
        ? null
        : breakSlot.state === 'en-cours'
          ? { text: 'BREAK', tint: 'text-dim' }
          : { text: 'BREAK à venir', tint: 'text-warn' },
  }
}
