import { ORPCError } from '@orpc/server'
import { asc, eq, inArray } from 'drizzle-orm'
import type { RoomPins } from '@conference-operator/contract'
import { roomPin, sessionSlot } from '@conference-operator/db/hub'
import type { HubDatabase } from '../db.js'
import type { Services } from '../context.js'

/**
 * The emergency gestures of a programme that no longer holds on site.
 *
 * Two of them, at two different levels, and the difference is the point:
 *
 * - **swap** corrects the programme itself: two talks exchange their slots, and
 *   every screen that reads the programme follows — the projector, the agenda,
 *   "next up", the other rooms. It is the gesture for an inversion decided a few
 *   minutes ahead.
 * - **pin** leaves the programme alone and tells one room "you are on that talk
 *   now". It is the gesture for the minute itself, when nobody has the time to
 *   think about slots.
 *
 * The checks live here, not in the router: the console, the room machine and the
 * mobile control app all reach these gestures, by three different paths, and the
 * rule must be the same on all three.
 */
export class PinService {
  constructor(
    private readonly db: HubDatabase,
    /** A room's pin changed: whoever watches it recomposes its view. */
    private readonly onChange: (roomId: string | null) => void = () => undefined,
  ) {}

  /** Every room's forced talk. */
  all(): RoomPins {
    return Object.fromEntries(
      this.db
        .select()
        .from(roomPin)
        .orderBy(asc(roomPin.roomId))
        .all()
        .map((row) => [row.roomId, row.sessionId]),
    )
  }

  get(roomId: string): string | null {
    return this.db.select().from(roomPin).where(eq(roomPin.roomId, roomId)).get()?.sessionId ?? null
  }

  set(roomId: string, sessionId: string, pinnedBy: string): void {
    const values = { roomId, sessionId, pinnedBy, pinnedAt: new Date().toISOString() }
    this.db
      .insert(roomPin)
      .values(values)
      .onConflictDoUpdate({ target: roomPin.roomId, set: values })
      .run()
    this.onChange(roomId)
  }

  /** @returns whether there was something to lift. */
  clear(roomId: string): boolean {
    const removed = this.db.delete(roomPin).where(eq(roomPin.roomId, roomId)).run().changes > 0
    if (removed) this.onChange(roomId)
    return removed
  }

  /**
   * Lifts every pin on these talks, wherever they are.
   *
   * @returns the rooms that lost their pin — empty when nothing changed, which
   * spares the rooms a broadcast for nothing.
   */
  clearSessions(sessionIds: readonly string[]): string[] {
    if (sessionIds.length === 0) return []
    const rows = this.db
      .select()
      .from(roomPin)
      .where(inArray(roomPin.sessionId, [...sessionIds]))
      .all()
    for (const row of rows) this.clear(row.roomId)
    return rows.map((row) => row.roomId)
  }

  /**
   * Swaps two talks' slots, in one transaction.
   *
   * Composes with what is already there: each talk takes the slot the *other*
   * currently occupies, so a chain of swaps stays a permutation of the export's
   * slots. A row that ends up pointing at its own talk is deleted — swapping a
   * pair back leaves the table exactly as before, and the served fingerprint
   * with it.
   */
  swapSlots(a: string, b: string): void {
    this.db.transaction((tx) => {
      const slotOf = (sessionId: string): string =>
        tx.select().from(sessionSlot).where(eq(sessionSlot.sessionId, sessionId)).get()?.slotOf ?? sessionId
      const toA = slotOf(b)
      const toB = slotOf(a)
      const updatedAt = new Date().toISOString()
      for (const [sessionId, target] of [
        [a, toA],
        [b, toB],
      ] as const) {
        if (target === sessionId) {
          tx.delete(sessionSlot).where(eq(sessionSlot.sessionId, sessionId)).run()
          continue
        }
        const values = { sessionId, slotOf: target, updatedAt }
        tx.insert(sessionSlot)
          .values(values)
          .onConflictDoUpdate({ target: sessionSlot.sessionId, set: values })
          .run()
      }
    })
  }

  /** Gives every swapped talk back to the export's slot. */
  resetSlots(): void {
    this.db.delete(sessionSlot).run()
  }
}

/**
 * The swap, checked against the **served** programme.
 *
 * @param roomId The caller's room, when a room asks: it may only swap two of its
 * own talks. Across rooms is the console's call — it is the one that sees both.
 */
export function swapTalks(
  services: Services,
  a: string,
  b: string,
  roomId: string | null,
): { contentHash: string } {
  if (a === b) {
    throw new ORPCError('BAD_REQUEST', { message: 'Choisissez deux conférences différentes.' })
  }
  const snapshot = services.programs.active()
  if (snapshot == null) {
    throw new ORPCError('NOT_FOUND', { message: 'Aucun programme actif sur ce hub' })
  }
  for (const id of [a, b]) {
    const session = snapshot.program.sessions.find((candidate) => candidate.id === id)
    if (session == null) {
      throw new ORPCError('NOT_FOUND', { message: `Conférence inconnue au programme : ${id}` })
    }
    /**
     * An inherited break has no slot of its own, and a wide slot spans rooms
     * whose screens would all have to change at once: neither is what the
     * gesture is for.
     */
    if (session.sharedFrom != null || session.kind !== 'talk') {
      throw new ORPCError('BAD_REQUEST', {
        message: `« ${session.title} » n'est pas une conférence : seules deux conférences s'échangent.`,
      })
    }
    if (session.roomSpan > 1) {
      throw new ORPCError('BAD_REQUEST', {
        message: `« ${session.title} » occupe plusieurs salles : elle ne s'échange pas.`,
      })
    }
    if (roomId != null && session.roomId !== roomId) {
      throw new ORPCError('FORBIDDEN', {
        message: "Cette conférence ne se tient pas dans votre salle : l'échange entre salles se fait depuis la console.",
      })
    }
    /**
     * A talk already started or ended keeps its place.
     *
     * Its lifecycle was written for the room and the hour it had — the room it
     * ran in, the end the sweep closes it on. Moving it would leave that state
     * pointing at a slot that is no longer its own.
     */
    const status = services.sessions.get(id)?.status ?? 'scheduled'
    if (status !== 'scheduled') {
      throw new ORPCError('CONFLICT', {
        message: `« ${session.title} » est déjà ${status === 'running' ? 'en cours' : 'terminée'} : remettez-la à « à venir » avant de l'échanger.`,
      })
    }
  }

  services.pins.swapSlots(a, b)
  // A pin on a talk that just moved would force a talk that is no longer there.
  if (services.pins.clearSessions([a, b]).length > 0) announcePins(services)
  return { contentHash: announceServedProgram(services, snapshot.contentHash) }
}

/** Gives every swapped slot back to the export. */
export function resetSwaps(services: Services): { contentHash: string } {
  const before = services.programs.active()?.contentHash ?? ''
  services.pins.resetSlots()
  return { contentHash: announceServedProgram(services, before) }
}

/**
 * Forces — or, with `null`, lifts — a room's current talk.
 *
 * A talk of the room itself, as the served programme places it: moving a talk
 * across rooms is what `swapTalks` is for, and keeping the pin inside the room is
 * what lets the lifecycle, the auto-end and the room's own slot list stay as they
 * are.
 */
export function pinTalk(
  services: Services,
  roomId: string,
  sessionId: string | null,
  author: string,
): RoomPins {
  if (sessionId == null) {
    if (services.pins.clear(roomId)) announcePins(services)
    return services.pins.all()
  }
  const snapshot = services.programs.active()
  const session = snapshot?.program.sessions.find((candidate) => candidate.id === sessionId)
  if (session == null) {
    throw new ORPCError('NOT_FOUND', { message: `Conférence inconnue au programme : ${sessionId}` })
  }
  if (session.sharedFrom != null || session.kind !== 'talk') {
    throw new ORPCError('BAD_REQUEST', {
      message: `« ${session.title} » n'est pas une conférence : rien à forcer.`,
    })
  }
  if (session.roomId !== roomId) {
    throw new ORPCError('BAD_REQUEST', {
      message: `« ${session.title} » ne se tient pas dans cette salle : échangez les créneaux pour la déplacer.`,
    })
  }
  if (services.sessions.get(sessionId)?.status === 'ended') {
    throw new ORPCError('CONFLICT', {
      message: `« ${session.title} » est terminée : remettez-la à « à venir » pour la forcer.`,
    })
  }
  if (services.pins.get(roomId) !== sessionId) {
    services.pins.set(roomId, sessionId, author)
    announcePins(services)
  }
  return services.pins.all()
}

/**
 * Lifts the pin a lifecycle gesture makes moot.
 *
 * Ending the forced talk is the natural way out of a pin: the room goes back to
 * the clock. Starting *another* talk of the room means the room has moved on
 * without it. Either way, leaving the pin would keep titling a talk nobody is
 * giving.
 */
export function releasePinAfter(
  services: Services,
  state: { sessionId: string; roomId: string | null; status: 'scheduled' | 'running' | 'ended' },
): void {
  if (state.roomId == null) return
  const pinned = services.pins.get(state.roomId)
  if (pinned == null) return
  const moot =
    (state.status === 'ended' && pinned === state.sessionId) ||
    (state.status === 'running' && pinned !== state.sessionId)
  if (moot && services.pins.clear(state.roomId)) announcePins(services)
}

/** Tells every room the whole map of pins: each also titles the others. */
export function announcePins(services: Services): void {
  services.commands.publish(null, { type: 'room.pins', pins: services.pins.all() }, null)
}

/**
 * Announces the programme as it is now served.
 *
 * Read back after the write: it is the fingerprint of what the rooms must
 * download, and a slot the lifecycle targets may have moved — the mobile control
 * apps watching any room recompose their view.
 */
export function announceServedProgram(services: Services, fallback: string): string {
  services.changes.touch(null)
  const contentHash = services.programs.active()?.contentHash ?? fallback
  services.commands.publish(null, { type: 'program.invalidate', contentHash }, null)
  return contentHash
}
