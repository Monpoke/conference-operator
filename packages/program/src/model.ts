/**
 * Normalized model consumed by the hub, the control app and the screens.
 * Nobody downstream should read the upstream JSON directly.
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

/** A room. Comes from `event.tracks[]`: an upstream track *is* a room. */
export interface Room {
  id: string
  name: string
}

/**
 * `break` = slot with no speaker (lunch, break, welcome).
 * An assumed heuristic: the upstream export does not distinguish slot kinds, and
 * the absence of a speaker is the only reliable signal we have.
 */
export type SessionKind = 'talk' | 'break'

export interface Session {
  id: string
  title: string
  abstract: string | null
  /** ISO 8601 with offset, as provided upstream. */
  startsAt: string
  endsAt: string | null
  /** Epoch ms — precomputed so the selectors never reparse. */
  startsAtMs: number
  endsAtMs: number | null
  durationMinutes: number | null
  roomId: string | null
  kind: SessionKind
  /**
   * Slot this one is the projection of in another room, or `null` for a slot of
   * the program itself.
   *
   * A room with nothing scheduled while another is on a break inherits that
   * break: a lunch the export only attaches to Track #1 nonetheless concerns
   * everyone. The copy carries the original's identifier, so we know where it
   * comes from and do not mistake it for an editable slot.
   */
  sharedFrom: string | null
  /**
   * OpenFeedback identifier corrected from the console, or `null`.
   *
   * `null` — the normal case — means the export's identifier is authoritative:
   * the `openfeedback.io/{project}/{day}/{id}` address is built betting that
   * OpenFeedback reuses the upstream numbering. The bet holds, but it would be
   * lost silently — clickable link, scannable QR code, a page that talks about no
   * talk — and we would only notice from the missing feedback.
   *
   * Set by the hub on the program it **serves**, like `kind` when a decision
   * contradicts it: that is what guarantees the console's link and the QR code
   * projected in the room cannot diverge.
   */
  feedbackId: string | null
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
 * A non-blocking anomaly met during normalization.
 * Reported in the admin console so it is seen at the rehearsal rather than in the
 * room.
 */
export interface ProgramIssue {
  code:
    | 'unknown-speaker'
    | 'unknown-track'
    | 'invalid-social-url'
    | 'missing-date'
    | 'duplicate-id'
  message: string
  /** Entity concerned, to point straight at it in the admin console. */
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
