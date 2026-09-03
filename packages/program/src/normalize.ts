import { rawProgramSchema, type RawSocial } from './raw-schema.js'
import type {
  Category,
  EventInfo,
  Format,
  Program,
  ProgramIssue,
  Room,
  Session,
  Social,
  Speaker,
  Sponsor,
  SponsorTier,
} from './model.js'

/**
 * Timezone used when the upstream export gives none.
 *
 * A fallback, not an assumption about the event: everything that shows a time
 * reads `program.timezone`, which the normalizer always fills in. The constant is
 * exported so that the rare surfaces which must show a time **before** having a
 * program — the console of a hub that has just been installed — fall back on the
 * same value as the rest, rather than each on its own.
 */
export const DEFAULT_TIMEZONE = 'Europe/Paris'

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function trimToNull(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Returns `null` rather than `NaN`: an invalid epoch must never leak. */
function toEpochMs(iso: string | null): number | null {
  if (iso == null) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

function indexById<T extends { id: string }>(
  items: T[],
  kind: string,
  issues: ProgramIssue[],
): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of items) {
    if (map.has(item.id)) {
      issues.push({
        code: 'duplicate-id',
        message: `${kind} en double, la première occurrence est conservée`,
        ref: item.id,
      })
      continue
    }
    map.set(item.id, item)
  }
  return map
}

function normalizeSocials(
  raw: RawSocial[],
  ownerRef: string,
  issues: ProgramIssue[],
): Social[] {
  const socials: Social[] = []
  for (const social of raw ?? []) {
    const url = trimToNull(social.link)
    const name = trimToNull(social.name) ?? trimToNull(social.icon) ?? 'link'
    if (url == null) continue
    // Seen in the real export: `link: "LinkedIn"` instead of a URL. We discard
    // rather than show a dead link on the projector.
    if (!isHttpUrl(url)) {
      issues.push({
        code: 'invalid-social-url',
        message: `lien social ignoré (« ${url} » n'est pas une URL)`,
        ref: ownerRef,
      })
      continue
    }
    socials.push({ name, icon: trimToNull(social.icon), url })
  }
  return socials
}

/**
 * Normalizes the upstream export into a usable model.
 *
 * Never throws on partial data: anomalies are collected in `program.issues` to be
 * shown in the admin console. Only structurally invalid JSON (no `event`) makes
 * the call fail.
 *
 * Note: sessions with no usable start date are excluded from `program.sessions` —
 * they cannot be placed on any timeline — and reported through a `missing-date`
 * issue.
 */
export function normalizeProgram(input: unknown): Program {
  const raw = rawProgramSchema.parse(input)
  const issues: ProgramIssue[] = []

  const rooms: Room[] = (raw.event.tracks ?? []).map((track) => ({
    id: track.id,
    name: track.name,
  }))
  const roomIds = new Set(rooms.map((room) => room.id))

  const categories: Category[] = (raw.event.categories ?? []).map((category) => ({
    id: category.id,
    name: category.name,
    color: trimToNull(category.color),
    colorSecondary: trimToNull(category.colorSecondary),
  }))

  const formats: Format[] = (raw.event.formats ?? []).map((format) => ({
    id: format.id,
    name: format.name,
    durationMinutes: format.durationMinutes ?? null,
  }))

  const speakers: Speaker[] = (raw.speakers ?? []).map((speaker) => ({
    id: speaker.id,
    name: speaker.name,
    jobTitle: trimToNull(speaker.jobTitle),
    company: trimToNull(speaker.company),
    bio: trimToNull(speaker.bio),
    photoUrl: trimToNull(speaker.photoUrl),
    companyLogoUrl: trimToNull(speaker.companyLogoUrl),
    socials: normalizeSocials(speaker.socials ?? [], `speaker:${speaker.id}`, issues),
  }))

  const speakerById = indexById(speakers, 'Speaker', issues)
  const categoryById = indexById(categories, 'Catégorie', issues)
  const formatById = indexById(formats, 'Format', issues)

  const sessions: Session[] = []
  for (const rawSession of raw.sessions ?? []) {
    const startsAt = trimToNull(rawSession.dateStart)
    const startsAtMs = toEpochMs(startsAt)
    if (startsAt == null || startsAtMs == null) {
      issues.push({
        code: 'missing-date',
        message: `session sans date de début exploitable, exclue de la timeline : « ${rawSession.title} »`,
        ref: rawSession.id,
      })
      continue
    }

    const speakerIds = rawSession.speakerIds ?? []
    const resolvedSpeakers: Speaker[] = []
    for (const speakerId of speakerIds) {
      const speaker = speakerById.get(speakerId)
      if (speaker == null) {
        issues.push({
          code: 'unknown-speaker',
          message: `speaker introuvable « ${speakerId} » sur « ${rawSession.title} »`,
          ref: rawSession.id,
        })
        continue
      }
      resolvedSpeakers.push(speaker)
    }

    const roomId = trimToNull(rawSession.trackId)
    if (roomId != null && !roomIds.has(roomId)) {
      issues.push({
        code: 'unknown-track',
        message: `salle introuvable « ${roomId} » sur « ${rawSession.title} »`,
        ref: rawSession.id,
      })
    }

    const endsAt = trimToNull(rawSession.dateEnd)
    sessions.push({
      id: rawSession.id,
      title: rawSession.title,
      abstract: trimToNull(rawSession.abstract),
      startsAt,
      endsAt,
      startsAtMs,
      endsAtMs: toEpochMs(endsAt),
      durationMinutes: rawSession.durationMinutes ?? null,
      roomId,
      kind: speakerIds.length > 0 ? 'talk' : 'break',
      // Nothing is projected at normalization time: the shared-breaks rule
      // applies to the normalized program, and is therefore read back from it.
      sharedFrom: null,
      // The export knows nothing of OpenFeedback: the correction, if one is
      // needed, is set on the served program, not on the one just normalized.
      feedbackId: null,
      speakers: resolvedSpeakers,
      category: (rawSession.categoryId != null ? categoryById.get(rawSession.categoryId) : undefined) ?? null,
      format: (rawSession.formatId != null ? formatById.get(rawSession.formatId) : undefined) ?? null,
      language: trimToNull(rawSession.language),
      level: trimToNull(rawSession.level),
      tags: rawSession.tags ?? [],
      imageUrl: trimToNull(rawSession.imageUrl),
    })
  }
  sessions.sort((a, b) => a.startsAtMs - b.startsAtMs || a.id.localeCompare(b.id))

  // The export does not sort the tiers: in the real file, "Gold" (order 0) comes
  // last. We sort here, once, so the screen does not have to.
  const sponsorTiers: SponsorTier[] = (raw.sponsors ?? [])
    .map((tier, index): SponsorTier => ({
      id: tier.id,
      name: tier.name,
      order: tier.order ?? index,
      sponsors: (tier.sponsors ?? []).map(
        (sponsor): Sponsor => ({
          id: sponsor.id,
          name: sponsor.name,
          website: trimToNull(sponsor.website),
          logoUrl: trimToNull(sponsor.logoUrl),
        }),
      ),
    }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))

  const event: EventInfo = {
    id: raw.event.id,
    name: raw.event.name,
    startsAt: trimToNull(raw.event.dateStart),
    endsAt: trimToNull(raw.event.dateEnd),
    locationName: trimToNull(raw.event.locationName),
    locationUrl: trimToNull(raw.event.locationUrl),
    language: trimToNull(raw.event.language),
    theme: {
      color: trimToNull(raw.event.color),
      colorSecondary: trimToNull(raw.event.colorSecondary),
      colorBackground: trimToNull(raw.event.colorBackground),
    },
    logoUrl: trimToNull(raw.event.logoUrl),
    logoUrl2: trimToNull(raw.event.logoUrl2),
    backgroundUrl: trimToNull(raw.event.backgroundUrl),
    intermissionMediaUrl: trimToNull(raw.event.intermissionMediaUrl),
  }

  return {
    event,
    timezone: trimToNull(raw.timezone) ?? DEFAULT_TIMEZONE,
    generatedAt: trimToNull(raw.generatedAt),
    rooms,
    sessions,
    speakers,
    categories,
    formats,
    sponsorTiers,
    issues,
  }
}
