import { z } from 'zod'

/**
 * What the intro and the outro of a published talk show.
 *
 * Resolved once, by whoever holds the program and the loop's settings (the hub,
 * or the local CLI from an export), and handed as is to the page that draws the
 * two clips: the page knows nothing of sessions, sponsors refs or the asset
 * cache. The images are addresses the renderer can reach — the worker inlines
 * them before capture, so a slow image never shows up half-loaded on a frame.
 *
 * Field names in French where they mirror the loop's (`rangs`, `taille`,
 * `echelle`): the outro is the loop's sponsor page, laid out the same way.
 */
export const vodLogoSchema = z.object({
  nom: z.string(),
  logoUrl: z.string().nullable(),
  echelle: z.number().min(0.2).max(2).default(0.7),
})
export type VodLogo = z.infer<typeof vodLogoSchema>

export const vodSponsorPageSchema = z.object({
  titre: z.string(),
  rangs: z.array(z.object({ taille: z.number().positive(), logos: z.array(vodLogoSchema) })),
})
export type VodSponsorPage = z.infer<typeof vodSponsorPageSchema>

export const vodHabillageSchema = z.object({
  event: z.object({
    /** « Cloud Nord 2026 ». */
    name: z.string(),
    /** Written as read: « 30 octobre 2026 ». `null` when the program has no date. */
    date: z.string().nullable(),
    /** The logo set in the console, the program's otherwise. */
    logoUrl: z.string().nullable(),
  }),
  talk: z.object({
    title: z.string(),
    category: z.string().nullable(),
    /** The category's colour, as the program gives it (`#rrggbb`). */
    color: z.string().nullable(),
  }),
  /** At most six: beyond that, the names no longer read on a 1080p frame. */
  speakers: z
    .array(z.object({ name: z.string(), company: z.string().nullable(), photoUrl: z.string().nullable() }))
    .max(6),
  /** « Merci à nos sponsors », or what the console says instead. */
  merci: z.string(),
  /** The loop's sponsor pages. Empty: the outro only thanks, without logos. */
  sponsorPages: z.array(vodSponsorPageSchema),
})
export type VodHabillage = z.infer<typeof vodHabillageSchema>

export type VodClip = 'intro' | 'outro'
