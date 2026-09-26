import { z } from 'zod'
import { isoDateTimeSchema, roomIdSchema, sessionIdSchema } from './primitives.js'

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

/* ---------------------------------------------------------------------------
 * The montage queue: the hub holds it, workers hosted anywhere take from it.
 *
 * Pull, not push: a worker asks for work, the hub never calls it. It needs no
 * open port, can sit behind any NAT, and there can be several. The hub keeps
 * the storage keys as for the rooms — a worker only ever gets signed addresses,
 * and only for the take it is editing.
 * ------------------------------------------------------------------------- */

export const montageStateSchema = z.enum(['attente', 'en-cours', 'termine', 'echoue', 'annule'])
export type MontageState = z.infer<typeof montageStateSchema>

export const montageEtapeSchema = z.enum(['telechargement', 'intro', 'outro', 'assemblage', 'envoi'])
export type MontageEtape = z.infer<typeof montageEtapeSchema>

export const markerRoleSchema = z.enum(['debut', 'fin'])

/** A job as the console shows it. */
export const montageJobViewSchema = z.object({
  id: z.string(),
  sessionId: sessionIdSchema,
  /** The talk's title in the active program; `null` for a talk it does not know. */
  title: z.string().nullable(),
  roomId: roomIdSchema,
  state: montageStateSchema,
  etape: montageEtapeSchema.nullable(),
  pourcent: z.number().int().min(0).max(100),
  tentatives: z.number().int().nonnegative(),
  worker: z.string().nullable(),
  /** Still waiting for its rush: not before this instant. */
  pasAvant: isoDateTimeSchema.nullable(),
  outputKey: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  /** Marks missing on the take: the talk was then kept whole on that side. */
  marquesManquantes: z.array(markerRoleSchema),
  erreur: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable(),
})
export type MontageJobView = z.infer<typeof montageJobViewSchema>

/** What a worker receives when it takes a job. */
export const montageClaimSchema = z.object({
  jobId: z.string(),
  sessionId: sessionIdSchema,
  roomId: roomIdSchema,
  /** The take's sidecar: it names the files, and holds the marks. */
  sidecarUrl: z.url(),
  habillage: vodHabillageSchema,
  /** The lease: without a heartbeat before then, the job goes back to the queue. */
  bail: isoDateTimeSchema,
})
export type MontageClaim = z.infer<typeof montageClaimSchema>

export const montageWorkerViewSchema = z.object({
  id: z.string(),
  nom: z.string(),
  createdAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema.nullable(),
  revokedAt: isoDateTimeSchema.nullable(),
})
export type MontageWorkerView = z.infer<typeof montageWorkerViewSchema>
