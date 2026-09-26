import type { Boucle, Sidecar, VodHabillage, VodLogo } from '@conference-operator/contract'
import {
  defaultSponsorPages,
  programSponsors,
  resolveSponsorRef,
  type Program,
  type SponsorPlacement,
} from '@conference-operator/program'

export interface VodHabillageSources {
  /** The program the talk was given in. `null`: only the sidecar is known. */
  program: Program | null
  /** The loop's settings — the console's logo and sponsor pages. */
  boucle: Pick<Boucle, 'logo' | 'sponsorPages' | 'merciSponsors'> | null
  /** The take's sidecar: what the room knew when it recorded. */
  sidecar: Pick<Sidecar, 'sessionId' | 'title' | 'speakers' | 'category'>
  /** The event's name as the console shows it (identity setting over program). */
  eventName: string | null
  /** An image's address for the renderer, or `null` to show the name instead. */
  localize: (ref: string | null) => string | null
}

const MAX_SPEAKERS = 6

/**
 * What the intro and outro of one talk show.
 *
 * Pure, like `buildBoucleView`, and built from the same sources: the program
 * holds the photos and the category colour, the sidecar the title as it was on
 * the day — a talk renamed in the program after the event keeps the program's
 * title, the one the audience will search for.
 */
export function buildVodHabillage(sources: VodHabillageSources): VodHabillage {
  const { program, boucle, sidecar, localize } = sources
  const session = program?.sessions.find((candidate) => candidate.id === sidecar.sessionId) ?? null

  const speakers = session != null && session.speakers.length > 0
    ? session.speakers.map((speaker) => ({
      name: speaker.name,
      company: speaker.company,
      photoUrl: localize(speaker.photoUrl),
    }))
    : sidecar.speakers.map((speaker) => ({ name: speaker.name, company: speaker.company, photoUrl: null }))

  const catalogue = program == null ? [] : programSponsors(program)
  const logo = (ref: SponsorPlacement): VodLogo => {
    const resolved = resolveSponsorRef(ref, catalogue)
    return { nom: resolved.nom, logoUrl: localize(resolved.logoUrl), echelle: resolved.echelle }
  }
  const pages = boucle?.sponsorPages ?? (program == null ? [] : defaultSponsorPages(program))

  return {
    event: {
      name: sources.eventName || program?.event.name || '',
      date: program == null ? null : eventDate(program),
      logoUrl: localize(boucle?.logo ?? program?.event.logoUrl ?? null),
    },
    talk: {
      title: session?.title ?? sidecar.title,
      category: session?.category?.name ?? sidecar.category,
      color: session?.category?.color ?? null,
    },
    speakers: speakers.slice(0, MAX_SPEAKERS),
    merci: boucle?.merciSponsors || 'Merci à nos sponsors',
    sponsorPages: pages
      .map((page) => ({
        titre: page.titre,
        rangs: page.rangs
          .map((row) => ({ taille: row.taille, logos: row.logos.map(logo) }))
          .filter((row) => row.logos.length > 0),
      }))
      .filter((page) => page.rangs.length > 0),
  }
}

/** « 30 octobre 2026 », in the event's time zone. */
function eventDate(program: Program): string | null {
  const start = program.event.startsAt
  if (start == null) return null
  const date = new Date(start)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: program.timezone,
  }).format(date)
}
