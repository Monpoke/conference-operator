/**
 * The day as a grid: one column per room, time going down.
 *
 * Height is time, so two talks at the same hour stand side by side: what a table
 * of twenty-seven rows could only tell by reading its first column.
 */

/** From this at the start, a talk reads as late. */
const RETARD_VISIBLE_MS = 5 * 60_000

/**
 * What really happened in a slot, for its cell: the hours, then how late it started.
 * `null` before it starts. A start left to the time rule has no delay to show: its
 * hour says nothing of the room.
 */
export function horaireReel(
  session: { startsAt: string; startedAt?: string | null; endedAt?: string | null; decidedBy?: string | null },
  hour: (iso: string) => string,
): { heures: string; retard: string | null; enRetard: boolean } | null {
  if (session.startedAt == null) return null
  const heures = `${hour(session.startedAt)}–${session.endedAt == null ? '…' : hour(session.endedAt)}`
  if (session.decidedBy === 'auto') return { heures, retard: null, enRetard: false }
  const ms = Date.parse(session.startedAt) - Date.parse(session.startsAt)
  const minutes = Math.round(Math.abs(ms) / 60_000)
  const retard = minutes === 0 ? "à l'heure" : `${ms > 0 ? '+' : '−'}${minutes} min`
  return { heures, retard, enRetard: ms >= RETARD_VISIBLE_MS }
}

export const PX_PER_MINUTE = 2.6
/** Shorter than this, a slot's title could no longer be read. */
const MIN_SLOT_PX = 30
/** A transition squeezed by the next talk stays a strip to click, without text. */
const STRIP_SLOT_PX = 6
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
/** Without an end in the program, a slot is drawn at this length. */
const DEFAULT_SLOT_MS = 30 * MINUTE_MS

export interface GridSession {
  id: string
  roomId?: string | null
  roomName?: string | null
  startsAt: string
  endsAt?: string | null
}

export interface GridSlot<S> {
  session: S
  topPx: number
  heightPx: number
}

export interface GridColumn<S> {
  key: string
  name: string
  slots: GridSlot<S>[]
}

export interface GridDay<S> {
  key: string
  fromMs: number
  heightPx: number
  /** The whole hours to graduate, with where they fall. */
  hours: { ms: number; topPx: number }[]
  columns: GridColumn<S>[]
}

const NO_ROOM = 'sans-salle'

/** Rooms in the program's order, those the program no longer names after them. */
export function planningGrid<S extends GridSession>(
  sessions: readonly S[],
  rooms: readonly { id: string; name: string }[],
  dayOf: (startsAt: string) => string,
): GridDay<S>[] {
  const byDay = new Map<string, S[]>()
  for (const session of sessions) {
    const day = dayOf(session.startsAt)
    byDay.set(day, [...(byDay.get(day) ?? []), session])
  }

  return [...byDay].map(([key, list]) => {
    const endOf = (session: S) =>
      session.endsAt == null ? Date.parse(session.startsAt) + DEFAULT_SLOT_MS : Date.parse(session.endsAt)
    const fromMs = Math.floor(Math.min(...list.map((session) => Date.parse(session.startsAt))) / HOUR_MS) * HOUR_MS
    const toMs = Math.max(...list.map(endOf))
    const toPx = (ms: number) => ((ms - fromMs) / MINUTE_MS) * PX_PER_MINUTE

    const known = rooms.filter((room) => list.some((session) => session.roomId === room.id))
    const others = new Map<string, string>()
    for (const session of list) {
      if (!known.some((room) => room.id === session.roomId)) {
        others.set(session.roomId ?? NO_ROOM, session.roomName ?? (session.roomId == null ? 'Sans salle' : session.roomId))
      }
    }
    const columns = [...known.map((room) => ({ key: room.id, name: room.name })), ...[...others].map(([id, name]) => ({ key: id, name }))]
      .map(({ key: roomKey, name }) => ({
        key: roomKey,
        name,
        slots: list
          .filter((session) => (session.roomId ?? NO_ROOM) === roomKey)
          .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
          .map((session, index, sorted) => {
            const topPx = toPx(Date.parse(session.startsAt))
            const next = sorted[index + 1]
            const room = next == null ? Number.POSITIVE_INFINITY : toPx(Date.parse(next.startsAt)) - topPx - 3
            return {
              session,
              topPx,
              heightPx: Math.max(STRIP_SLOT_PX, Math.min(room, Math.max(MIN_SLOT_PX, toPx(endOf(session)) - topPx - 3))),
            }
          }),
      }))

    const hours: { ms: number; topPx: number }[] = []
    for (let ms = fromMs; ms <= toMs; ms += HOUR_MS) hours.push({ ms, topPx: toPx(ms) })
    return { key, fromMs, heightPx: toPx(toMs) + MIN_SLOT_PX, hours, columns }
  })
}
