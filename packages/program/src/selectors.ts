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

/** Où en est une salle, en un mot. Voir `roomConferenceState`. */
export type RoomConferenceState = 'aucune' | 'pause' | 'en-cours' | 'fin-proche' | 'depassement'

/** En deçà, une conférence est « vers la fin » : le moment où une décision se prend. */
export const FIN_PROCHE_MS = 5 * 60_000

/**
 * État de la salle tel que les consoles le peignent.
 *
 * Deux sources, et l'ordre compte :
 *
 * - `pilotedSessionId` — ce que la salle pilote réellement — l'emporte, parce
 *   qu'il est le seul à révéler un **dépassement**. Le programme, lui, passe au
 *   créneau suivant dès l'heure de fin et ne dira jamais qu'une salle déborde ;
 * - le programme donne tout le reste, à l'heure passée en `nowMs`.
 *
 * Une salle qui pilote une conférence absente du programme (import remplacé en
 * cours de journée) n'est pas en dépassement pour autant : sans créneau, il n'y
 * a rien à dépasser, et on retombe sur ce que dit le programme.
 */
export function roomConferenceState(
  program: Program,
  roomId: string,
  nowMs: number,
  pilotedSessionId: string | null = null,
): RoomConferenceState {
  const sessions = sessionsForRoom(program, roomId)

  if (pilotedSessionId != null) {
    const index = sessions.findIndex((session) => session.id === pilotedSessionId)
    if (index !== -1) {
      const fin = effectiveEndMs(sessions[index]!, sessions[index + 1])
      if (fin != null && fin <= nowMs) return 'depassement'
    }
  }

  const { current } = roomTimelinePosition(program, roomId, nowMs)
  if (current == null) return 'aucune'
  if (current.kind === 'break') return 'pause'

  const fin = effectiveEndMs(current, sessions[sessions.indexOf(current) + 1])
  return fin != null && fin - nowMs <= FIN_PROCHE_MS ? 'fin-proche' : 'en-cours'
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

/**
 * Adresse publique OpenFeedback d'une conférence.
 *
 * Fabriquée sans le moindre appel réseau : OpenFeedback réutilise les
 * identifiants de session de l'export amont — vérifié, les 27 concordent — et
 * sa route publique est `/{projet}/{aaaa-mm-jj}/{session}`. C'est ce qui permet
 * au QR de se dessiner en salle réseau coupé, et au hub de lister les liens
 * sans dépendre d'une API.
 *
 * Le jour se lit dans le fuseau de l'**événement**, pas en UTC : à Paris, un
 * créneau de fin de soirée basculerait sinon sur le lendemain et le lien
 * tomberait sur une page vide. Il vient de la session elle-même, ce qui rend la
 * fonction juste sur un événement à plusieurs jours.
 *
 * `null` sans projet configuré : pas de lien vaut mieux qu'un lien mort.
 */
export function openFeedbackUrl(
  session: Pick<Session, 'id' | 'startsAt'>,
  projectId: string | null,
  timezone: string,
): string | null {
  if (projectId == null || projectId.trim() === '') return null
  const jour = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(session.startsAt))
  return `https://openfeedback.io/${encodeURIComponent(projectId)}/${jour}/${encodeURIComponent(session.id)}`
}
