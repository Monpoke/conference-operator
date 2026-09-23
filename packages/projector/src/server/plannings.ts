import {
  DUREE_PLANNING_PAR_DEFAUT,
  MAX_PLANNINGS,
  type Boucle,
  type DisplayPayload,
} from '@conference-operator/contract'
import { agendaForRoom, type Program } from '@conference-operator/program'

/**
 * The other rooms' days, for the loop's schedule scenes.
 *
 * Each by the same rule as the room's own agenda (`agendaForRoom`), in the
 * program's room order, with the hub's settings: a room can be taken out, and
 * each has its own time on screen. What happens in the room the screen stands
 * in is left out — the opening keynote held here is on this room's own agenda,
 * and showing it again under another room's name would send people away from
 * where they already are. The shared breaks stay: they are everyone's. At most `MAX_PLANNINGS`: that many scenes are
 * mounted ahead.
 */
export function planningsFor(
  program: Program,
  roomId: string | null,
  boucle: Boucle | null,
  nowMs: number,
): DisplayPayload['plannings'] {
  return program.rooms
    .filter((room) => room.id !== roomId)
    .map((room) => ({ room, reglage: boucle?.plannings[room.id] }))
    .filter(({ reglage }) => reglage?.afficher !== false)
    .slice(0, MAX_PLANNINGS)
    .map(({ room, reglage }) => ({
      roomId: room.id,
      nom: room.name,
      duree: reglage?.duree ?? DUREE_PLANNING_PAR_DEFAUT,
      agenda: agendaForRoom(program, room.id, { nowMs })
        .filter((entry) => entry.pause || entry.roomId !== roomId),
    }))
}
