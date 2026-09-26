import { z } from 'zod'
import { isoDateTimeSchema, roomIdSchema, sessionIdSchema } from './primitives.js'

/** An analysis file's name: a short slug and one of three kinds. */
export const ARTEFACT_NAME = /^[a-z0-9-]{1,40}\.(png|jpg|mp3)$/

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

export const montageStateSchema = z.enum(['attente', 'en-cours', 'a-valider', 'termine', 'echoue', 'annule'])
export type MontageState = z.infer<typeof montageStateSchema>

export const montageEtapeSchema = z.enum(['telechargement', 'analyse', 'intro', 'outro', 'assemblage', 'envoi'])
export type MontageEtape = z.infer<typeof montageEtapeSchema>

export const markerRoleSchema = z.enum(['debut', 'fin'])

/** What was done to the talk's sound. */
export const montageAudioSchema = z.object({
  /** Integrated loudness of the kept part, as recorded. */
  lufsAvant: z.number(),
  /** What it was brought to; `null` when nothing was brought up (near silent). */
  lufsApres: z.number().nullable(),
  truePeak: z.number(),
  lra: z.number(),
  /** One gain for the whole talk; `false`: `loudnorm` had to ride the level. */
  lineaire: z.boolean(),
  /** Under -50 LUFS: a muted microphone, an empty track — not brought up. */
  quasiMuet: z.boolean(),
})
export type MontageAudio = z.infer<typeof montageAudioSchema>

/**
 * Where one end of the cut comes from, from the surest to the least sure:
 * the operator's mark, the room's « Commencer »/« Terminer », the first or
 * last words heard, the edge of the take — and `manuel`, a cut moved by hand
 * in the console, which is surest of all.
 */
export const cutSourceSchema = z.enum(['marque', 'regie', 'parole', 'prise', 'manuel'])
export type CutSource = z.infer<typeof cutSourceSchema>

export const cutSideSchema = z.object({
  source: cutSourceSchema,
  /** Moved onto a silence. */
  calee: z.boolean(),
  /** How far from the source it moved; negative is earlier. */
  deplacementMs: z.number().int(),
})
export type CutSide = z.infer<typeof cutSideSchema>

/** The cut the video was edited on, in the take's time. */
export const montageCoupeSchema = z.object({
  debutMs: z.number().int().nonnegative(),
  finMs: z.number().int().positive(),
  debut: cutSideSchema,
  fin: cutSideSchema,
})
export type MontageCoupe = z.infer<typeof montageCoupeSchema>

/**
 * A job is analysed first — where to cut, how loud — then edited. Between the
 * two, a doubtful cut waits in `a-valider` for somebody to look at it.
 */
export const montagePhaseSchema = z.enum(['analyse', 'montage'])
export type MontagePhase = z.infer<typeof montagePhaseSchema>

export const confianceSchema = z.enum(['haute', 'moyenne', 'basse'])

/**
 * When an analysed cut goes to the montage without anybody looking.
 *
 * `si-confiance-haute` by default: two marks set in the room and each moved
 * onto a silence close by is a cut nobody needs to check; a cut guessed from
 * the room's buttons or from the words heard waits for somebody. A hub
 * setting, not part of the upload policy: the rooms have no use for it.
 */
export const montageAutoSchema = z.enum(['jamais', 'si-confiance-haute', 'toujours'])
export type MontageAuto = z.infer<typeof montageAutoSchema>
export type Confiance = z.infer<typeof confianceSchema>

/** What the analysis found, as the worker reports it. */
export const montageAnalyseSchema = z.object({
  proposition: montageCoupeSchema,
  confiance: confianceSchema,
  /** In words, for the console: where each end comes from, what looked wrong. */
  raisons: z.array(z.string().max(300)).max(20),
  audio: montageAudioSchema.nullable(),
  takeMs: z.number().int().positive(),
  /** Files uploaded beside the take for the console: waveform, stills, excerpts. */
  artefacts: z.array(z.string().regex(ARTEFACT_NAME)).max(20),
})
export type MontageAnalyse = z.infer<typeof montageAnalyseSchema>

/** The room's lifecycle for the talk, handed to the analysis. */
export const montageRegieSchema = z.object({
  startedAt: isoDateTimeSchema.nullable(),
  endedAt: isoDateTimeSchema.nullable(),
  auto: z.boolean(),
  /** Room clock minus hub clock, measured on the room's live events. */
  decalageMs: z.number().int().nullable(),
})
export type MontageRegie = z.infer<typeof montageRegieSchema>


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
  /** Marks missing on the take: the talk was then cut from another source on that side. */
  marquesManquantes: z.array(markerRoleSchema),
  phase: montagePhaseSchema,
  /** What the analysis proposed; `null` before it ran. */
  analyse: montageAnalyseSchema.nullable(),
  /** The cut the video is edited on — validated, by hand or automatically. */
  coupe: montageCoupeSchema.nullable(),
  /** Who validated it: an operator's email, or `auto`. */
  valideePar: z.string().nullable(),
  /** What was done to the sound, once edited. */
  audio: montageAudioSchema.nullable(),
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
  phase: montagePhaseSchema,
  /** For the analysis: the room's buttons, when the take has no marks. */
  regie: montageRegieSchema.nullable(),
  /** For the montage: the validated cut. */
  coupe: montageCoupeSchema.nullable(),
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
