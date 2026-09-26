import type { DisplayPayload, RoomPins } from '@conference-operator/contract'
import { sessionsForRoom, type Program } from '@conference-operator/program'
import { timelinePosition } from '@conference-operator/program/selectors'

/**
 * What is going on, or about to go on, in the other rooms.
 *
 * Computed on the program and a corrected clock — the room's, or the hub's for
 * its preview — never on the machine's time, which can be weeks away when the
 * hub runs on a simulated clock. The breaks are discarded: "Lunch in Track #2"
 * helps nobody choose where to go.
 *
 * A room's forced talk wins over the clock: it is the one actually on next door,
 * and sending the audience to the talk the schedule names would send them to the
 * wrong one.
 */
export function otherRoomsFor(
  program: Program,
  roomId: string | null,
  at: number,
  pins: RoomPins = {},
): DisplayPayload['otherRooms'] {
  return program.rooms
    .filter((room) => room.id !== roomId)
    .map((room) => {
      /**
       * The position is computed on **all** the slots, breaks included, and we
       * keep only the talks afterwards.
       *
       * The order matters: a slot's end is derived from the next one's start when
       * the export does not give it, and searching directly in a filtered list
       * skipped the break that closes it. A talk with no end time then stayed
       * "running" on the neighbouring screen until the end of the day.
       */
      const slots = sessionsForRoom(program, room.id)
      const pinned = slots.find((slot) => slot.id === pins[room.id] && slot.kind === 'talk') ?? null
      const { current } = timelinePosition(slots, at)
      const runningTalk = pinned ?? (current?.kind === 'talk' ? current : null)
      const session = runningTalk ?? slots.find((c) => c.kind === 'talk' && c.startsAtMs > at) ?? null
      return {
        roomId: room.id,
        name: room.name,
        session:
          session == null
            ? null
            : {
                id: session.id,
                title: session.title,
                startsAt: session.startsAt,
                speakers: session.speakers.map((person) => person.name),
              },
        running: session != null && session === runningTalk,
      }
    })
}
