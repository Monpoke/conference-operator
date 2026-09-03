import type { Program, Session } from './model.js'

/** A room's sessions, sorted by start time (the sorting comes from the normalizer). */
export function sessionsForRoom(program: Program, roomId: string): Session[] {
  return program.sessions.filter((session) => session.roomId === roomId)
}

/**
 * What a slot needs to carry to be placed in time.
 *
 * Deliberately narrower than `Session`: the control app handles slots
 * deserialized from its cache, and the state machine walks them without ever
 * reading a title or a speaker. Requiring the whole session would force it to
 * fabricate a complete one just to ask a scheduling question.
 */
export type ScheduledSession = Pick<Session, 'startsAtMs' | 'endsAtMs' | 'durationMinutes'>

/**
 * Effective end of a session, in order of preference:
 * explicit `endsAt` → `durationMinutes` → start of the next session.
 * Returns `null` if none of the three is available (open-ended session).
 */
export function effectiveEndMs(
  session: ScheduledSession,
  next: ScheduledSession | undefined,
): number | null {
  if (session.endsAtMs != null) return session.endsAtMs
  if (session.durationMinutes != null) return session.startsAtMs + session.durationMinutes * 60_000
  return next?.startsAtMs ?? null
}

export interface TimelinePosition<T> {
  /** Running session, or `null` between two slots (the screen then switches to the overlay). */
  current: T | null
  next: T | null
  previous: T | null
}

export type RoomTimelinePosition = TimelinePosition<Session>

/**
 * Position in an already sorted sequence of slots, at a given instant.
 *
 * The list form is the real one: it is what the hub, which starts from a
 * `Program`, and the pages, which only have their room's slots in cache, share.
 * Each used to derive its own version, and they had ended up answering
 * differently on the last slot of the day.
 *
 * `nowMs` is always injected by the caller — never `Date.now()` internally: the
 * client corrects its clock with the server offset, and the tests must be able to
 * freeze time.
 */
export function timelinePosition<T extends ScheduledSession>(
  sessions: T[],
  nowMs: number,
): TimelinePosition<T> {
  let current: T | null = null
  let next: T | null = null
  let previous: T | null = null

  for (let i = 0; i < sessions.length; i += 1) {
    const session = sessions[i]!
    if (session.startsAtMs > nowMs) {
      next = session
      break
    }
    const end = effectiveEndMs(session, sessions[i + 1])
    if (end == null || nowMs < end) {
      current = session
      next = sessions[i + 1] ?? null
      break
    }
    previous = session
  }

  return { current, next, previous }
}

/** Position in a room's timeline. Wrapper around `timelinePosition`. */
export function roomTimelinePosition(
  program: Program,
  roomId: string,
  nowMs: number,
): RoomTimelinePosition {
  return timelinePosition(sessionsForRoom(program, roomId), nowMs)
}

export function currentSession(program: Program, roomId: string, nowMs: number): Session | null {
  return roomTimelinePosition(program, roomId, nowMs).current
}

export function nextSession(program: Program, roomId: string, nowMs: number): Session | null {
  return roomTimelinePosition(program, roomId, nowMs).next
}

/**
 * Every remote URL to preload into the local cache.
 *
 * It is the list the client downloads at sync: after that, no OBS browser source
 * should touch the internet during the event.
 */
export function assetUrls(program: Program): string[] {
  const urls = new Set<string>()
  const add = (url: string | null): void => {
    if (url != null && url.length > 0) urls.add(url)
  }

  add(program.event.logoUrl)
  add(program.event.logoUrl2)
  add(program.event.backgroundUrl)
  add(program.event.intermissionMediaUrl)
  for (const speaker of program.speakers) {
    add(speaker.photoUrl)
    add(speaker.companyLogoUrl)
  }
  for (const tier of program.sponsorTiers) {
    for (const sponsor of tier.sponsors) add(sponsor.logoUrl)
  }
  for (const session of program.sessions) add(session.imageUrl)

  return [...urls]
}

/** The event's local time (`program.timezone`), not the control machine's. */
export function formatTime(iso: string, timezone: string, locale = 'fr-FR'): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(new Date(iso))
}

export function formatSessionRange(session: Session, timezone: string, locale = 'fr-FR'): string {
  const start = formatTime(session.startsAt, timezone, locale)
  if (session.endsAt == null) return start
  return `${start} – ${formatTime(session.endsAt, timezone, locale)}`
}

/**
 * A talk's public OpenFeedback address.
 *
 * Built with no network call at all: OpenFeedback reuses the session identifiers
 * of the upstream export — checked, all 27 match — and its public route is
 * `/{project}/{yyyy-mm-dd}/{session}`. That is what lets the QR code be drawn in
 * a room with the network cut, and the hub list the links without depending on an
 * API.
 *
 * The day is read in the **event's** timezone, not in UTC: in Paris, a late
 * evening slot would otherwise roll over to the next day and the link would land
 * on an empty page. It comes from the session itself, which makes the function
 * correct on a multi-day event.
 *
 * `null` with no project configured: no link beats a dead link.
 *
 * `session.feedbackId`, set by the hub on the program it serves, overrides the
 * export's identifier for the case where the bet above does not hold. It is set
 * per slot from the console: the address is still built offline, but it stops
 * being a derivation impossible to correct the day OpenFeedback no longer numbers
 * like the upstream. Read here, and not passed as a parameter by every caller:
 * that is what stops the console's link and the projected QR code from diverging.
 */
export function openFeedbackUrl(
  session: Pick<Session, 'id' | 'startsAt'> & { feedbackId?: string | null },
  projectId: string | null,
  timezone: string,
): string | null {
  if (projectId == null || projectId.trim() === '') return null
  const corrected = session.feedbackId?.trim() ?? ''
  const identifier = corrected === '' ? session.id : corrected
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(session.startsAt))
  return `https://openfeedback.io/${encodeURIComponent(projectId)}/${day}/${encodeURIComponent(identifier)}`
}
