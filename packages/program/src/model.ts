/**
 * Modèle normalisé consommé par le hub, la régie et les écrans.
 * Personne en aval ne doit lire le JSON amont directement.
 */

export interface Social {
  name: string
  icon: string | null
  url: string
}

export interface Speaker {
  id: string
  name: string
  jobTitle: string | null
  company: string | null
  bio: string | null
  photoUrl: string | null
  companyLogoUrl: string | null
  socials: Social[]
}

export interface Category {
  id: string
  name: string
  color: string | null
  colorSecondary: string | null
}

export interface Format {
  id: string
  name: string
  durationMinutes: number | null
}

/** Une salle. Vient de `event.tracks[]` : un track amont *est* une salle. */
export interface Room {
  id: string
  name: string
}

/**
 * `break` = créneau sans speaker (déjeuner, pause, accueil).
 * Heuristique assumée : l'export amont ne distingue pas les types de créneaux,
 * et l'absence de speaker est le seul signal fiable dont on dispose.
 */
export type SessionKind = 'talk' | 'break'

export interface Session {
  id: string
  title: string
  abstract: string | null
  /** ISO 8601 avec offset, tel que fourni en amont. */
  startsAt: string
  endsAt: string | null
  /** Epoch ms — précalculé pour que les sélecteurs ne reparsent jamais. */
  startsAtMs: number
  endsAtMs: number | null
  durationMinutes: number | null
  roomId: string | null
  kind: SessionKind
  speakers: Speaker[]
  category: Category | null
  format: Format | null
  language: string | null
  level: string | null
  tags: string[]
  imageUrl: string | null
}

export interface Sponsor {
  id: string
  name: string
  website: string | null
  logoUrl: string | null
}

export interface SponsorTier {
  id: string
  name: string
  order: number
  sponsors: Sponsor[]
}

export interface EventInfo {
  id: string
  name: string
  startsAt: string | null
  endsAt: string | null
  locationName: string | null
  locationUrl: string | null
  language: string | null
  theme: {
    color: string | null
    colorSecondary: string | null
    colorBackground: string | null
  }
  logoUrl: string | null
  logoUrl2: string | null
  backgroundUrl: string | null
  intermissionMediaUrl: string | null
}

/**
 * Anomalie non bloquante rencontrée à la normalisation.
 * Remontée dans l'admin pour être vue à la répétition plutôt qu'en salle.
 */
export interface ProgramIssue {
  code:
    | 'unknown-speaker'
    | 'unknown-track'
    | 'invalid-social-url'
    | 'missing-date'
    | 'duplicate-id'
  message: string
  /** Entité concernée, pour pointer directement dessus dans l'admin. */
  ref?: string
}

export interface Program {
  event: EventInfo
  timezone: string
  generatedAt: string | null
  rooms: Room[]
  sessions: Session[]
  speakers: Speaker[]
  categories: Category[]
  formats: Format[]
  sponsorTiers: SponsorTier[]
  issues: ProgramIssue[]
}
