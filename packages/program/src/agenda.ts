import type { Program, Session } from './model.js'

/**
 * One row of a room's day, as the welcome loop's agenda shows it.
 *
 * Deliberately flat and already resolved: the projected page renders it as is,
 * with no rule of its own to apply.
 */
export interface AgendaEntry {
  id: string
  title: string
  startsAtMs: number
  endsAtMs: number
  /** Shared slot with no speaker — breakfast, lunch, coffee: shown small. */
  pause: boolean
  /** Short format name ("Conférence", "Quickie"), or `null`. */
  format: string | null
  /** Upper-case language code when it is not French ("EN"), or `null`. */
  language: string | null
  /**
   * Name of the room where it takes place, when that is **not** this one — the
   * opening keynote, shown on every screen with an orange pill. `null` here.
   */
  elsewhere: string | null
  speakers: { name: string; company: string | null }[]
}

export interface AgendaOptions {
  /** A slot overlapped by nothing (the opening keynote) appears in every room. */
  plenaries: boolean
  /** Corrected clock of the caller — picks the day to show. */
  nowMs: number
}

/**
 * The day of one room for the welcome loop.
 *
 * A port of the reference loop's rule, which differs from the control room's on
 * purpose:
 * - a slot belongs to its room **and to the neighbouring rooms it covers** in the
 *   upstream grid (`roomSpan`): the breakfast laid across three tracks is in all
 *   three, the croissant break across two is not in the Hands on room;
 * - a slot that no other overlaps is a plenary — the opening keynote — and shows
 *   on every screen, with the name of the room where it happens;
 * - only one day: today, or the next one with sessions, or the last one.
 *
 * Works on the program's own slots: the copies `applySharedBreaks` projects into
 * free rooms (`sharedFrom`) would otherwise count twice.
 */
export function agendaForRoom(program: Program, roomId: string, options: AgendaOptions): AgendaEntry[] {
  const rooms = program.rooms
  const index = rooms.findIndex((room) => room.id === roomId)
  if (index < 0) return []

  const dayOf = dayFormatter(program.timezone)
  interface Placed {
    session: Session
    first: number
    last: number
    start: number
    end: number
  }
  let placed: Placed[] = []
  for (const session of program.sessions) {
    if (session.sharedFrom != null || session.roomId == null) continue
    const first = rooms.findIndex((room) => room.id === session.roomId)
    if (first < 0) continue
    const end = session.endsAtMs
      ?? (session.durationMinutes != null ? session.startsAtMs + session.durationMinutes * 60_000 : null)
    if (end == null) continue
    placed.push({ session, first, last: first + Math.max(1, session.roomSpan ?? 1) - 1, start: session.startsAtMs, end })
  }

  const days = [...new Set(placed.map((p) => dayOf(p.start)))].sort()
  const today = dayOf(options.nowMs)
  const day = days.includes(today) ? today : (days.find((d) => d > today) ?? days[days.length - 1])
  placed = placed.filter((p) => dayOf(p.start) === day)

  const here = (p: Placed) => p.first <= index && index <= p.last
  const isPause = (p: Placed) => p.last > p.first && p.session.speakers.length === 0 && p.session.format == null
  const alone = (p: Placed) =>
    !isPause(p) && !placed.some((o) => o !== p && o.start < p.end && p.start < o.end)

  return placed
    .filter((p) => here(p) || (options.plenaries && alone(p)))
    .sort((a, b) => a.start - b.start || a.first - b.first)
    .map((p): AgendaEntry => {
      const language = (p.session.language ?? '').toLowerCase()
      return {
        id: p.session.id,
        title: p.session.title,
        startsAtMs: p.start,
        endsAtMs: p.end,
        pause: isPause(p),
        format: p.session.format ? p.session.format.name.replace(/\s*\(.*\)\s*$/, '') : null,
        language: language && language !== 'fr' ? language.toUpperCase() : null,
        elsewhere: here(p) ? null : rooms[p.first]!.name,
        speakers: p.session.speakers.map((s) => ({ name: s.name, company: s.company })),
      }
    })
}

/** `YYYY-MM-DD` of an instant in the event's timezone, whatever the machine's. */
function dayFormatter(timezone: string): (ms: number) => string {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return (ms) => {
    const parts = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]))
    return `${parts.year}-${parts.month}-${parts.day}`
  }
}
