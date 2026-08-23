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
    /**
     * Un créneau qui n'est pas une conférence ne déborde pas.
     *
     * Il n'y a rien à y terminer — personne ne clôture un déjeuner —, et un
     * état « en cours » peut lui rester d'avant : le hub sert le programme
     * décisions comprises, et une conférence déjà lancée peut être déclarée
     * break en cours de journée. La signaler en dépassement ferait clignoter la
     * console sur un fait qu'on vient soi-même de corriger.
     */
    if (session.kind === 'break') return false
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
 * En deçà, un break qui approche s'annonce.
 *
 * Un quart d'heure : c'est le moment où l'on cesse de lancer quoi que ce soit
 * et où l'on commence à préparer la reprise. Plus tôt, l'information ne sert
 * pas ; plus tard, elle arrive après la décision qu'elle devait éclairer.
 */
export const BREAK_PROCHE_MS = 15 * 60_000

export interface RoomBreak {
  /** `en-cours` : le break court. `a-venir` : il commence dans moins d'un quart d'heure. */
  state: 'en-cours' | 'a-venir'
  session: Session
  /** Reprise : fin effective du break, ou `null` si rien ne le ferme. */
  endsAtMs: number | null
}

/**
 * Le break d'une salle, en cours ou imminent.
 *
 * Une donnée à part de `roomConferenceState`, et non un état de plus : elle
 * cohabite avec ce que fait la salle. Une conférence peut courir pendant que le
 * déjeuner approche — c'est même le cas qui compte, celui où l'on décide de ne
 * pas laisser filer.
 *
 * `null` le reste du temps : l'étiquette n'apparaît que quand elle a quelque
 * chose à dire.
 */
export function roomBreak(program: Program, roomId: string, nowMs: number): RoomBreak | null {
  const sessions = sessionsForRoom(program, roomId)
  const reprise = (session: Session): number | null =>
    effectiveEndMs(session, sessions[sessions.indexOf(session) + 1])

  const { current, next } = roomTimelinePosition(program, roomId, nowMs)
  if (current?.kind === 'break') {
    return { state: 'en-cours', session: current, endsAtMs: reprise(current) }
  }
  /**
   * Le créneau suivant, qu'une conférence coure ou non.
   *
   * C'est là qu'est l'intérêt : savoir que le déjeuner tombe dans douze minutes
   * pendant qu'un talk se termine est ce qui fait décider de ne pas enchaîner.
   * Ne regarder que les salles déjà vides aurait donné l'information à ceux qui
   * n'en avaient plus besoin.
   */
  if (next?.kind === 'break' && next.startsAtMs - nowMs <= BREAK_PROCHE_MS) {
    return { state: 'a-venir', session: next, endsAtMs: reprise(next) }
  }
  return null
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
