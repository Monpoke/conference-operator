import { roomBreak, roomConferenceState, type SessionStatuses } from '@conference-operator/room-state'
import { currentSession } from '@conference-operator/program'
import type { RoomStatus } from '@conference-operator/contract'
import type { Services } from './context.js'
import type { PushPayload } from './services/push.js'

/**
 * Full state of the rooms: what the database knows, enriched with the program.
 *
 * One implementation for two readers — the console, which queries, and the
 * watch, which monitors. Separating them would have let a status dot's colour
 * and a notice pushed to a phone diverge, which is exactly the kind of gap you
 * only notice in the room.
 *
 * @param at The hub's time. It may be simulated, and it is authoritative.
 */
export function roomStatuses(services: Services, at: number): RoomStatus[] {
  const snapshot = services.programs.active()
  const statusesOf = (roomId: string): SessionStatuses =>
    Object.fromEntries(
      services.sessions.states(roomId).map((state) => [state.sessionId, state.status]),
    )

  return services.rooms.statuses().map((status) => {
    const session = snapshot == null ? null : currentSession(snapshot.program, status.roomId, at)
    const roomPause = snapshot == null ? null : roomBreak(snapshot.program, status.roomId, at)
    return {
      ...status,
      breakBadge:
        roomPause == null
          ? null
          : {
              state: roomPause.state,
              title: roomPause.session.title,
              startsAt: roomPause.session.startsAt,
              endsAt:
                roomPause.endsAtMs == null ? null : new Date(roomPause.endsAtMs).toISOString(),
            },
      currentSession:
        session == null
          ? null
          : {
              id: session.id,
              title: session.title,
              endsAt: session.endsAt,
              remainingMs: session.endsAtMs == null ? null : session.endsAtMs - at,
            },
      conference:
        snapshot == null
          ? ('aucune' as const)
          : roomConferenceState(snapshot.program, status.roomId, at, statusesOf(status.roomId)),
    }
  })
}

/**
 * What the hub notices by itself, to push to the closed consoles.
 *
 * An open console compared two refreshes and notified itself. With the console
 * closed there is nobody left to compare: the hub has to do it, and it is the
 * only place it can be done from. The rules are the same on both sides, by
 * design — a notice that changes meaning depending on whether the page is open
 * would be worse than no notice at all.
 *
 * The `tag` is the one the page uses too: two notifications with the same tag
 * replace each other instead of stacking, which avoids the duplicate when the
 * console is open *and* subscribed.
 */

interface RoomView {
  connectivity: string
  conference: string
}

/** A talk's title, for a readable notice. `null` outside the program. */
export type SessionTitleOf = (sessionId: string) => string | null

export class SupervisionWatch {
  private readonly views = new Map<string, RoomView>()
  /**
   * Known talk statuses, by room then by session.
   *
   * Diffed here, and not derived from the aggregated state: a talk that ends on
   * time goes straight from "running" to "none", and the event would be missed.
   * It is the lifecycle that carries the start and the end, not the colour drawn
   * from it.
   */
  private readonly statuses = new Map<string, Map<string, string>>()
  /**
   * Pairing codes already seen. `null` until a pass has happened: without that
   * distinction, the first round would announce as new the requests that were
   * already waiting.
   */
  private pairings: string[] | null = null

  /**
   * Compares the rooms' state with the previous one and returns what deserves a
   * notice.
   *
   * The very first pass warns about nothing. Starting the hub on an already
   * disconnected room is not an event, it is a state — and three notifications at
   * switch-on would make the next ones invisible.
   *
   * @param sessionStatuses Lifecycle per room: `{ roomId: { sessionId: status } }`.
   * @param titleOf Resolves a talk's title, so we do not notify an opaque
   *   identifier.
   */
  pass(
    statuses: RoomStatus[],
    pending: { clientId: string }[] = [],
    sessionStatuses: Record<string, Record<string, string>> = {},
    titleOf: SessionTitleOf = () => null,
  ): PushPayload[] {
    const notices: PushPayload[] = []
    const first = this.views.size === 0

    for (const room of statuses) {
      const before = this.views.get(room.roomId)
      this.views.set(room.roomId, {
        connectivity: room.connectivity,
        conference: room.conference,
      })
      if (!first && before != null) {
        notices.push(...this.roomNotices(room, before))
      }
      notices.push(
        ...this.talkNotices(room, before ?? null, sessionStatuses[room.roomId] ?? {}, titleOf, first),
      )
    }

    // Rooms that disappeared from the program: otherwise their last state would
    // stay in memory and a return would be announced as a change.
    const known = new Set(statuses.map((room) => room.roomId))
    for (const roomId of [...this.views.keys()]) {
      if (!known.has(roomId)) {
        this.views.delete(roomId)
        this.statuses.delete(roomId)
      }
    }

    const codes = pending.map((request) => request.clientId).sort()
    if (this.pairings != null) {
      const added = codes.filter((code) => !this.pairings!.includes(code))
      if (added.length > 0) {
        notices.push({
          title:
            added.length === 1
              ? 'Une machine attend son appairage'
              : `${added.length} machines attendent leur appairage`,
          body: "Le code est affiché sur l'écran de régie.",
          tag: 'appairage',
          view: 'appairage',
          family: 'technique',
          level: 'essentiel',
        })
      }
    }
    this.pairings = codes

    return notices
  }

  /** What becomes of the machine: it goes quiet, or it comes back. */
  private roomNotices(room: RoomStatus, before: RoomView): PushPayload[] {
    const tag = `salle-${room.roomId}`
    if (room.connectivity !== 'ONLINE' && before.connectivity === 'ONLINE') {
      return [
        {
          title: `${room.name} ne répond plus`,
          body: 'Plus de nouvelles de la machine de salle.',
          tag,
          view: 'exploitation',
          family: 'technique',
          level: 'essentiel',
        },
      ]
    }
    if (room.connectivity === 'ONLINE' && before.connectivity !== 'ONLINE') {
      // A relief, not a decision: reserved for whoever wants to follow everything.
      return [
        {
          title: `${room.name} est revenue`,
          body: 'La machine de salle répond de nouveau.',
          tag,
          view: 'exploitation',
          family: 'technique',
          level: 'tout',
        },
      ]
    }
    return []
  }

  /** What becomes of the day: what starts, ends, drags or overruns. */
  private talkNotices(
    room: RoomStatus,
    /** The room's previous state, captured **before** the view was overwritten. */
    before: RoomView | null,
    roomStatuses: Record<string, string>,
    titleOf: SessionTitleOf,
    first: boolean,
  ): PushPayload[] {
    const notices: PushPayload[] = []
    const tag = `conf-${room.roomId}`
    const known = this.statuses.get(room.roomId) ?? new Map<string, string>()

    for (const [sessionId, status] of Object.entries(roomStatuses)) {
      const previous = known.get(sessionId) ?? 'scheduled'
      known.set(sessionId, status)
      // First pass: we take note without announcing anything. The hub sometimes
      // restarts mid-day, and it must not replay the morning.
      if (first || previous === status) continue

      const title = titleOf(sessionId)
      if (status === 'running') {
        notices.push({
          title: `${room.name} · c'est parti`,
          body: title ?? 'La conférence a commencé.',
          tag,
          view: 'exploitation',
          family: 'exploitation',
          level: 'tout',
        })
      } else if (status === 'ended' && previous === 'running') {
        notices.push({
          title: `${room.name} · terminé`,
          body: title ?? 'La conférence est terminée.',
          tag,
          view: 'exploitation',
          family: 'exploitation',
          level: 'tout',
        })
      }
    }
    this.statuses.set(room.roomId, known)

    if (first || before == null) return notices

    if (room.conference === 'depassement' && before.conference !== 'depassement') {
      // The only state that calls for a decision: it is what shifts the day.
      notices.push({
        title: `${room.name} déborde`,
        body: 'Le créneau est fini, la conférence est toujours en cours.',
        tag,
        view: 'exploitation',
        family: 'exploitation',
        level: 'essentiel',
      })
    } else if (room.conference === 'retard' && before.conference !== 'retard') {
      notices.push({
        title: `${room.name} n'a pas démarré`,
        body: 'Le créneau a commencé, la conférence n’est pas lancée.',
        tag,
        view: 'exploitation',
        family: 'exploitation',
        level: 'essentiel',
      })
    } else if (room.conference === 'fin-proche' && before.conference !== 'fin-proche') {
      notices.push({
        title: `${room.name} · cinq minutes`,
        body: 'La conférence touche à sa fin.',
        tag,
        view: 'exploitation',
        family: 'exploitation',
        level: 'tout',
      })
    }
    return notices
  }
}
