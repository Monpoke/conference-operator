import { z } from 'zod'

/**
 * The event's identity, as every surface displays it.
 *
 * A single source for the public wall, the console, the room screen, window
 * titles and pushed notifications. Without it, the event name was hard-coded in
 * a dozen places: changing edition — or running the product on another event —
 * meant reading through the whole repository and shipping a new release to the
 * room machines.
 *
 * It is not entered in a configuration file: the hub **derives it from the
 * imported program**, which already carries `event.name`. The setting only
 * exists for cases where the upstream export does not say what we want to read
 * on screen.
 */
export const eventIdentitySchema = z.object({
  /**
   * Full name, year included: "Cloud Nord 2026".
   *
   * That is what goes at the top of the public wall and of the console — the two
   * places someone can land on without knowing where they have ended up.
   */
  name: z.string().min(1).max(80),
  /**
   * Short name, without the year: "Cloud Nord".
   *
   * For places where space is short and the year teaches nothing: control app
   * window title, title of a notification pushed to a phone, projected waiting
   * loop ("Suivez …"). Derived from the full name when not configured.
   */
  shortName: z.string().min(1).max(40),
})
export type EventIdentity = z.infer<typeof eventIdentitySchema>

/**
 * What the surfaces show when nothing is known: no imported program, no setting.
 *
 * This case really happens — a hub that has just been installed, before the
 * first import — and a neutral word beats a hard-coded event name that would be
 * wrong everywhere else.
 */
export const DEFAULT_EVENT_IDENTITY: EventIdentity = { name: 'Événement', shortName: 'Événement' }

/**
 * Strips from an event name what dates it.
 *
 * "Cloud Nord 2026" → "Cloud Nord", "DevFest Lille #12" → "DevFest Lille". An
 * assumed heuristic, and deliberately timid: it only cuts a recognisable suffix
 * at the end of the string, and returns the name unchanged as soon as it is
 * unsure. A wrong short name would be read on every screen of the day; a short
 * name that is too long goes unnoticed.
 *
 * The hub's `eventShortName` setting exists for the names it misses.
 */
export function derivedShortName(name: string): string {
  const cut = name.replace(/[\s]*[—–\-·|,]?[\s]*(?:(?:19|20)\d{2}|#\d+|éd(?:ition)?\.?\s*\d+)\s*$/iu, '').trim()
  // A name that is *only* its year ("2026") does not get shortened.
  return cut === '' ? name.trim() : cut
}

/** What the hub has to decide from, in decreasing order of priority. */
export interface EventIdentitySources {
  /**
   * Hub settings. What is entered there wins: it is the only place where someone
   * explicitly said what they wanted to read.
   */
  setting?: { name?: string | null; shortName?: string | null } | null
  /**
   * `program.event.name` of the active snapshot.
   *
   * The normal source, and the one that makes the product agnostic without
   * asking anything: importing another event's program is enough to rename every
   * surface.
   */
  program?: string | null
}

/**
 * Decides the displayed identity.
 *
 * Explicit setting, else imported program, else neutral default — and the short
 * name is derived from the chosen name, not from another source: setting the
 * full name without thinking about the short one must give a coherent result.
 */
export function resolveEventIdentity(sources: EventIdentitySources = {}): EventIdentity {
  const clean = (value: string | null | undefined): string | null => {
    const text = value?.trim() ?? ''
    return text === '' ? null : text
  }

  const name =
    clean(sources.setting?.name) ?? clean(sources.program) ?? DEFAULT_EVENT_IDENTITY.name
  const shortName = clean(sources.setting?.shortName) ?? derivedShortName(name)

  // The schema's bounds apply to what comes from the upstream export too, which
  // has no reason to respect them: a 300-character name would fail the `sync`
  // validation of every room.
  return eventIdentitySchema.parse({
    name: name.slice(0, 80),
    shortName: shortName.slice(0, 40),
  })
}
