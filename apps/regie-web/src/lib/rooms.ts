import type { ControlDiagnostics, DisplayPayload } from '@cloudnord/contract'
import {
  appearanceOf,
  outlineOf,
  stateFromProgram,
  authoritativeState,
  effectiveEndAt,
  breakOfSlots,
  STALE_VIEW_MS,
} from '@cloudnord/room-state'
import type { Session } from '@cloudnord/program'
import { timelinePosition } from '@cloudnord/program/selectors'
import { duration, time } from '@cloudnord/format'

/** Ce que le hub sait d'une salle, ou `null` si sa vue ne l'a pas encore. */
export function hubView(
  payload: DisplayPayload,
  roomId: string,
): ControlDiagnostics['rooms'][number] | null {
  return (payload.diagnostics?.rooms ?? []).find((room) => room.roomId === roomId) ?? null
}

/**
 * L'état d'une salle : le programme local, sauf pour ce que lui seul ignore.
 *
 * L'arbitrage — quels états le hub est seul à connaître, et jusqu'à quelle
 * fraîcheur sa vue fait foi — vit dans la lib, avec le calcul qu'il arbitre. On
 * n'apporte ici que ce qu'on est seul à avoir : la date du dernier
 * rafraîchissement.
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
   * Programme absent du cache : le dire.
   *
   * « hors créneau » se lirait comme une salle sans rien de prévu, alors qu'on
   * ignore tout de la sienne.
   */
  if (name === 'aucune' && sessions.length === 0) {
    return { fill: 'off', word: 'programme inconnu', text: 'text-dim' }
  }
  const looks = appearanceOf(name)
  return { fill: looks.tint, word: looks.word, text: looks.text }
}

/** Une case du flux d'en-tête : tout ce qu'elle affiche, déjà décidé. */
export interface RoomStripEntry {
  id: string
  name: string
  dot: string
  /** Titre de ce qui s'y joue, ou vide quand ce n'est pas le titre qui compte. */
  label: string
  detail: string
  tint: string
  breakTag: { text: string; tint: string } | null
}

/**
 * Les autres salles, vues des deux sources qui en parlent.
 *
 * Le programme donne la liste et les créneaux même hub coupé ; l'état remonté
 * par le hub ajoute la connectivité et l'enregistrement quand il est joignable.
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
 * Ce qu'une salle voisine affiche dans le bandeau.
 *
 * Toute la logique du flux tient ici, hors composant, parce qu'elle se vérifie
 * sur des instants choisis : « en cours · fin 10:45 », « vers la fin · 3 min »,
 * « reprise 14:00 » et « dépassement » sont quatre phrases dont chacune décide
 * si on lance le talk d'à côté maintenant ou dans cinq minutes.
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
    // Le programme est passé au créneau suivant ; la salle, non. C'est elle qui
    // a raison, et c'est ce qui décale toute la journée.
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
    // Pas de libellé : l'étiquette BREAK le dit déjà, et « Déjeuner » à la place
    // d'un titre de conférence se lisait comme une salle occupée. Ce qui décide
    // ici, c'est l'heure de reprise.
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
   * L'étiquette du break, à côté du nom de la salle.
   *
   * Elle cohabite avec ce que fait la salle : « BREAK à venir » s'affiche
   * pendant qu'une conférence court encore, et c'est là qu'elle sert.
   */
  const pause = breakOfSlots(sessions, atMs)

  return {
    id: room.id,
    name: room.name,
    dot: `${state.fill}${outlineOf(view?.connectivity ?? room.connectivity)}`.trim(),
    label,
    detail,
    tint,
    breakTag:
      pause == null
        ? null
        : pause.state === 'en-cours'
          ? { text: 'BREAK', tint: 'text-dim' }
          : { text: 'BREAK à venir', tint: 'text-warn' },
  }
}
