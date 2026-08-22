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
export type RoomConferenceState =
  | 'aucune'
  | 'pause'
  | 'pas-commencee'
  | 'retard'
  | 'en-cours'
  | 'fin-proche'
  | 'terminee'
  | 'depassement'

/** En deçà, une conférence est « vers la fin » : le moment où une décision se prend. */
export const FIN_PROCHE_MS = 5 * 60_000

/**
 * Au-delà, un créneau commencé que personne n'a lancé devient un retard.
 *
 * Les premières minutes ne disent rien : le public s'installe, l'intervenant
 * branche son PC. C'est après que l'absence de démarrage devient une question.
 */
export const RETARD_MS = 5 * 60_000

/** Cycle de vie des conférences d'une salle, par identifiant. */
export type SessionStatuses = Record<string, 'scheduled' | 'running' | 'ended'>

/**
 * État de la salle tel que les consoles le peignent.
 *
 * Croise deux sources qui disent des choses différentes :
 *
 * - **le programme** donne le créneau : ce qui *devrait* se jouer, à `nowMs` ;
 * - **le cycle de vie** (`Commencer` / `Terminer` en régie) donne ce qui se
 *   joue vraiment. Lui seul révèle un **dépassement** — le programme, passé
 *   l'heure de fin, passe simplement au créneau suivant — et lui seul distingue
 *   un talk en cours d'un créneau que personne n'a lancé.
 *
 * À défaut de cycle de vie, une salle apparaît « pas commencée » puis « en
 * retard » tout du long. C'est assumé : la console ne peut pas deviner qu'un
 * talk tourne si personne ne le dit, et le mot affiché à côté de la pastille
 * évite de lire cette absence comme une panne.
 */
export function roomConferenceState(
  program: Program,
  roomId: string,
  nowMs: number,
  statuses: SessionStatuses = {},
): RoomConferenceState {
  const sessions = sessionsForRoom(program, roomId)

  /**
   * Le dépassement d'abord : c'est le seul état qui parle d'un créneau *passé*,
   * et le seul qui décale la suite de la journée.
   */
  const deborde = sessions.some((session, index) => {
    if (statuses[session.id] !== 'running') return false
    const fin = effectiveEndMs(session, sessions[index + 1])
    return fin != null && fin <= nowMs
  })
  if (deborde) return 'depassement'

  const { current } = roomTimelinePosition(program, roomId, nowMs)
  if (current == null) return 'aucune'
  if (current.kind === 'break') return 'pause'

  const statut = statuses[current.id] ?? 'scheduled'
  // Terminée avant l'heure : la salle est libre, et c'est une information pour
  // celle d'à côté — pas un créneau vide.
  if (statut === 'ended') return 'terminee'

  if (statut === 'running') {
    const fin = effectiveEndMs(current, sessions[sessions.indexOf(current) + 1])
    return fin != null && fin - nowMs <= FIN_PROCHE_MS ? 'fin-proche' : 'en-cours'
  }
  return nowMs - current.startsAtMs > RETARD_MS ? 'retard' : 'pas-commencee'
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
