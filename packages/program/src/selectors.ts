import type { Program, Room, Session } from './model.js'

/** Sessions d'une salle, triées par heure de début (le tri vient du normaliseur). */
export function sessionsForRoom(program: Program, roomId: string): Session[] {
  return program.sessions.filter((session) => session.roomId === roomId)
}

export function roomById(program: Program, roomId: string): Room | null {
  return program.rooms.find((room) => room.id === roomId) ?? null
}

/**
 * Fin effective d'une session, par ordre de préférence :
 * `endsAt` explicite → `durationMinutes` → début de la session suivante.
 * Retourne `null` si aucune des trois n'est disponible (session ouverte).
 */
export function effectiveEndMs(session: Session, next: Session | undefined): number | null {
  if (session.endsAtMs != null) return session.endsAtMs
  if (session.durationMinutes != null) return session.startsAtMs + session.durationMinutes * 60_000
  return next?.startsAtMs ?? null
}

export interface RoomTimelinePosition {
  /** Session en cours, ou `null` entre deux créneaux (l'écran bascule alors en habillage). */
  current: Session | null
  next: Session | null
  previous: Session | null
}

/**
 * Position dans la timeline d'une salle à un instant donné, en une seule passe.
 *
 * `nowMs` est toujours injecté par l'appelant — jamais `Date.now()` en interne :
 * le client corrige son horloge avec l'offset serveur, et les tests doivent
 * pouvoir figer le temps.
 */
export function roomTimelinePosition(
  program: Program,
  roomId: string,
  nowMs: number,
): RoomTimelinePosition {
  const sessions = sessionsForRoom(program, roomId)
  let current: Session | null = null
  let next: Session | null = null
  let previous: Session | null = null

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

export function currentSession(program: Program, roomId: string, nowMs: number): Session | null {
  return roomTimelinePosition(program, roomId, nowMs).current
}

export function nextSession(program: Program, roomId: string, nowMs: number): Session | null {
  return roomTimelinePosition(program, roomId, nowMs).next
}

/**
 * Toutes les URLs distantes à précharger dans le cache local.
 *
 * C'est la liste que le client télécharge au sync : après ça, plus aucune source
 * navigateur d'OBS ne doit toucher Internet pendant l'événement.
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

/** Heure locale de l'événement (`Europe/Paris`), pas celle du PC de régie. */
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
