import type { Program, Session } from './model.js'
import { effectiveEndMs, sessionsForRoom } from './selectors.js'

/**
 * One room's breaks hold for the rooms that have nothing scheduled.
 *
 * The upstream export only attaches a slot to **one** track: lunch, the welcome
 * breakfast, the coffee break appear on the main room and nowhere else. The other
 * rooms therefore showed a hole while the whole event was having lunch — "hors
 * créneau" on the status dot, a neutral overlay on screen, and nothing to say to
 * an audience that came in through the wrong door.
 *
 * The rule fills that hole without inventing anything: a room **free for the
 * whole duration** of a break held elsewhere inherits that break. Free for the
 * *whole* duration, and not just at the start: an overlap, even partial, means
 * the room has its own program at that moment, and trimming a break to fit the
 * remaining interval would manufacture a slot nobody put in the program.
 *
 * The projection is **derived**, never stored: it is recomputed on the served
 * program, day-of decisions included. Declaring a slot a "break" from the console
 * therefore makes it appear in the other free rooms, and giving it back to "talk"
 * removes it — with nothing else having to follow.
 */
export function applySharedBreaks(program: Program): Program {
  const breaks = program.sessions.filter(
    (session) => session.kind === 'break' && session.roomId != null,
  )
  if (breaks.length === 0 || program.rooms.length < 2) return program

  const added: Session[] = []
  for (const room of program.rooms) {
    const own = sessionsForRoom(program, room.id)
    /**
     * The same break can be held by several rooms — two tracks each carrying
     * their own 15:00 "Pause café". The free room only inherits it once: two
     * identical rows in its timeline would read as two successive slots.
     */
    const seen = new Set<string>()

    for (const roomBreak of breaks) {
      if (roomBreak.roomId === room.id) continue
      const end = endOf(roomBreak, program)
      // A break we cannot close is not projected: it would run to the end of the
      // day in a room that may well have a talk.
      if (end == null) continue

      const slot = `${roomBreak.startsAtMs}-${end}-${roomBreak.title}`
      if (seen.has(slot)) continue
      if (own.some((session, index) => overlaps(session, endAt(own, index), roomBreak.startsAtMs, end))) {
        continue
      }

      seen.add(slot)
      added.push({
        ...roomBreak,
        // Derived identifier: two rooms cannot carry the same one, and you can
        // read where the copy comes from without comparing it to anything.
        id: `${roomBreak.id}@${room.id}`,
        roomId: room.id,
        sharedFrom: roomBreak.id,
      })
    }
  }

  if (added.length === 0) return program

  return {
    ...program,
    // Re-sorted the way the normalizer does: everything downstream assumes a list
    // ordered by start time, starting with the position in the timeline.
    sessions: [...program.sessions, ...added].sort(
      (a, b) => a.startsAtMs - b.startsAtMs || a.id.localeCompare(b.id),
    ),
  }
}

/** Effective end of a break, the next session of *its* room being authoritative. */
function endOf(roomBreak: Session, program: Program): number | null {
  const neighbours = roomBreak.roomId == null ? [] : sessionsForRoom(program, roomBreak.roomId)
  const index = neighbours.indexOf(roomBreak)
  return effectiveEndMs(roomBreak, index < 0 ? undefined : neighbours[index + 1])
}

function endAt(sessions: Session[], index: number): number | null {
  return effectiveEndMs(sessions[index]!, sessions[index + 1])
}

/**
 * Do two intervals touch?
 *
 * Right-open bounds: a talk that ends at 11:15 does not overlap a break that
 * starts at 11:15. That is the common case — slots run edge to edge — and
 * treating it as an overlap would cancel the rule everywhere it is useful.
 */
function overlaps(session: Session, end: number | null, start: number, breakEnd: number): boolean {
  // Slot with an unknown end: it runs until proven otherwise, so it occupies the
  // room. Better not to project than to project on top.
  if (end == null) return session.startsAtMs < breakEnd
  return session.startsAtMs < breakEnd && end > start
}
