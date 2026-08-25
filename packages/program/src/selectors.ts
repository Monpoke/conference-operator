import type { Program, Room, Session } from './model.js'

/** Sessions d'une salle, triées par heure de début (le tri vient du normaliseur). */
export function sessionsForRoom(program: Program, roomId: string): Session[] {
  return program.sessions.filter((session) => session.roomId === roomId)
}

export function roomById(program: Program, roomId: string): Room | null {
  return program.rooms.find((room) => room.id === roomId) ?? null
}

/**
 * Ce qu'il faut d'un créneau pour le situer dans le temps.
 *
 * Volontairement plus étroit que `Session` : la régie manipule des créneaux
 * désérialisés depuis son cache, et l'automate d'état les traverse sans jamais
 * lire un titre ni un intervenant. Exiger la session entière obligerait à en
 * fabriquer une complète pour poser une question d'horaire.
 */
export type SessionHoraire = Pick<Session, 'startsAtMs' | 'endsAtMs' | 'durationMinutes'>

/**
 * Fin effective d'une session, par ordre de préférence :
 * `endsAt` explicite → `durationMinutes` → début de la session suivante.
 * Retourne `null` si aucune des trois n'est disponible (session ouverte).
 */
export function effectiveEndMs(
  session: SessionHoraire,
  next: SessionHoraire | undefined,
): number | null {
  if (session.endsAtMs != null) return session.endsAtMs
  if (session.durationMinutes != null) return session.startsAtMs + session.durationMinutes * 60_000
  return next?.startsAtMs ?? null
}

export interface TimelinePosition<T> {
  /** Session en cours, ou `null` entre deux créneaux (l'écran bascule alors en habillage). */
  current: T | null
  next: T | null
  previous: T | null
}

export type RoomTimelinePosition = TimelinePosition<Session>

/**
 * Position dans une suite de créneaux déjà triée, à un instant donné.
 *
 * La forme liste est la vraie : c'est elle que partagent le hub, qui part d'un
 * `Program`, et les pages, qui n'ont en cache que les créneaux de leur salle.
 * Les deux en tiraient chacune leur version, et elles avaient fini par ne plus
 * répondre pareil sur le dernier créneau de la journée.
 *
 * `nowMs` est toujours injecté par l'appelant — jamais `Date.now()` en interne :
 * le client corrige son horloge avec l'offset serveur, et les tests doivent
 * pouvoir figer le temps.
 */
export function timelinePosition<T extends SessionHoraire>(
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

/** Position dans la timeline d'une salle. Enveloppe de `timelinePosition`. */
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

/** Heure locale de l'événement (`program.timezone`), pas celle du PC de régie. */
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
