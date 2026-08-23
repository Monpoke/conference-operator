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
 * Fuseau retenu quand l'export amont n'en donne aucun.
 *
 * Un repli, pas une hypothèse sur l'événement : tout ce qui affiche une heure
 * lit `program.timezone`, que le normaliseur renseigne toujours. La constante
 * est exportée pour que les rares surfaces qui doivent afficher une heure
 * **avant** d'avoir un programme — la console d'un hub tout juste installé —
 * retombent sur la même valeur que le reste, plutôt que chacune sur la sienne.
 */
export const FUSEAU_PAR_DEFAUT = 'Europe/Paris'

const DEFAULT_TIMEZONE = FUSEAU_PAR_DEFAUT

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

/** Retourne `null` plutôt que `NaN` : un epoch invalide ne doit jamais fuiter. */
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
    // Vu dans l'export réel : `link: "LinkedIn"` au lieu d'une URL. On écarte
    // plutôt que d'afficher un lien mort sur le projecteur.
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
 * Normalise l'export amont en modèle exploitable.
 *
 * Ne lève jamais sur des données partielles : les anomalies sont collectées dans
 * `program.issues` pour être affichées dans l'admin. Seul un JSON structurellement
 * invalide (pas d'`event`) fait échouer l'appel.
 *
 * Note : les sessions sans date de début exploitable sont exclues de
 * `program.sessions` — elles ne peuvent être placées sur aucune timeline — et
 * signalées via une issue `missing-date`.
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

  // L'export ne trie pas les tiers : dans le fichier réel, « Gold » (order 0)
  // arrive en dernier. On trie ici, une fois, pour que l'écran n'ait pas à le faire.
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
