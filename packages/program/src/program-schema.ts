import { z } from 'zod'
import type { Program } from './model.js'

/**
 * Zod schema of the *normalized* model (not to be confused with `raw-schema.ts`,
 * which describes the upstream JSON).
 *
 * Used to validate a snapshot received over the wire or read back from the SQLite
 * cache: the client must not show a corrupted program on the projector.
 *
 * The interfaces of `model.ts` remain the reference for reading; the
 * compatibility assertion at the end of the file fails the typecheck if the two
 * drift apart.
 */

export const socialSchema = z.object({
  name: z.string(),
  icon: z.string().nullable(),
  url: z.string(),
})

export const speakerSchema = z.object({
  id: z.string(),
  name: z.string(),
  jobTitle: z.string().nullable(),
  company: z.string().nullable(),
  bio: z.string().nullable(),
  photoUrl: z.string().nullable(),
  companyLogoUrl: z.string().nullable(),
  socials: z.array(socialSchema),
})

export const categorySchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  colorSecondary: z.string().nullable(),
})

export const formatSchema = z.object({
  id: z.string(),
  name: z.string(),
  durationMinutes: z.number().nullable(),
})

export const roomSchema = z.object({
  id: z.string(),
  name: z.string(),
})

export const sessionKindSchema = z.enum(['talk', 'break'])

export const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  abstract: z.string().nullable(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  startsAtMs: z.number(),
  endsAtMs: z.number().nullable(),
  durationMinutes: z.number().nullable(),
  roomId: z.string().nullable(),
  kind: sessionKindSchema,
  /**
   * Projection of a slot from another room. See `Session.sharedFrom`.
   *
   * A default value, and not a required field: a local cache written before this
   * field existed must keep reading back. A room restarting with an unreachable
   * hub only has that cache.
   */
  sharedFrom: z.string().nullable().default(null),
  /**
   * OpenFeedback identifier corrected from the console, or `null`.
   *
   * A field set by the hub on the program it **serves**, like `kind` when a
   * decision contradicts it and like `sharedFrom`: that is what guarantees the
   * console and the QR code projected in the room cannot diverge. The room draws
   * its QR codes offline from this cache — having it receive the correction
   * through another channel would mean holding the same truth in two places, and
   * projecting the old address in front of the audience the day the two fell out
   * of sync.
   *
   * `null` — the normal case — means "the export's identifier is authoritative".
   * A default value and not a required field, for the same reason as
   * `sharedFrom`: a cache written before this field must keep reading back.
   */
  feedbackId: z.string().nullable().default(null),
  speakers: z.array(speakerSchema),
  category: categorySchema.nullable(),
  format: formatSchema.nullable(),
  language: z.string().nullable(),
  level: z.string().nullable(),
  tags: z.array(z.string()),
  imageUrl: z.string().nullable(),
})

export const sponsorSchema = z.object({
  id: z.string(),
  name: z.string(),
  website: z.string().nullable(),
  logoUrl: z.string().nullable(),
})

export const sponsorTierSchema = z.object({
  id: z.string(),
  name: z.string(),
  order: z.number(),
  sponsors: z.array(sponsorSchema),
})

export const eventInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  locationName: z.string().nullable(),
  locationUrl: z.string().nullable(),
  language: z.string().nullable(),
  theme: z.object({
    color: z.string().nullable(),
    colorSecondary: z.string().nullable(),
    colorBackground: z.string().nullable(),
  }),
  logoUrl: z.string().nullable(),
  logoUrl2: z.string().nullable(),
  backgroundUrl: z.string().nullable(),
  intermissionMediaUrl: z.string().nullable(),
})

export const programIssueSchema = z.object({
  code: z.enum([
    'unknown-speaker',
    'unknown-track',
    'invalid-social-url',
    'missing-date',
    'duplicate-id',
  ]),
  message: z.string(),
  ref: z.string().optional(),
})

export const programSchema = z.object({
  event: eventInfoSchema,
  timezone: z.string(),
  generatedAt: z.string().nullable(),
  rooms: z.array(roomSchema),
  sessions: z.array(sessionSchema),
  speakers: z.array(speakerSchema),
  categories: z.array(categorySchema),
  formats: z.array(formatSchema),
  sponsorTiers: z.array(sponsorTierSchema),
  issues: z.array(programIssueSchema),
})

/**
 * A compile-time guard: if `model.ts` and `programSchema` drift apart, one of
 * these two assignments stops compiling.
 */
type SchemaProgram = z.infer<typeof programSchema>
const _schemaMatchesModel: SchemaProgram = null as unknown as Program
const _modelMatchesSchema: Program = null as unknown as SchemaProgram
void _schemaMatchesModel
void _modelMatchesSchema
