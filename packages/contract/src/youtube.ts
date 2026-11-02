import { z } from 'zod'
import { vodHabillageSchema } from './montage.js'

/** The link to the channel. The client's secret and the channel's token never come back. */
export const youtubeStatusSchema = z.object({
  clientId: z.string().nullable(),
  hasSecret: z.boolean(),
  connected: z.boolean(),
  channel: z.string().nullable(),
  /** The edition's playlist, once made. */
  playlist: z.object({ id: z.string(), title: z.string(), publique: z.boolean(), videos: z.number().int().nonnegative() }).nullable(),
  /** To declare in the Google project, as an authorised redirect address. */
  redirectUri: z.string(),
})
export type YoutubeStatus = z.infer<typeof youtubeStatusSchema>

export const youtubeVignetteSchema = z.object({
  /** `playlist`, or the montage job's id. */
  cle: z.string(),
  state: z.enum(['attente', 'calcul', 'prete', 'envoi', 'envoyee', 'echec']),
  erreur: z.string().nullable(),
  updatedAt: z.string(),
})
export type YoutubeVignette = z.infer<typeof youtubeVignetteSchema>

/** What a worker draws: a video's thumbnail, or the playlist's. */
export const vignetteClaimSchema = z.object({
  cle: z.string(),
  habillage: vodHabillageSchema,
  /** The event's place, for the playlist's image. */
  lieu: z.string().nullable(),
})
export type VignetteClaim = z.infer<typeof vignetteClaimSchema>

export const youtubeEnvoiStateSchema = z.enum(['attente', 'en-cours', 'termine', 'echoue'])

export const youtubeEnvoiSchema = z.object({
  jobId: z.string(),
  state: youtubeEnvoiStateSchema,
  videoId: z.string().nullable(),
  visibilite: z.enum(['private', 'public']),
  octets: z.number().int().nonnegative(),
  taille: z.number().int().nullable(),
  erreur: z.string().nullable(),
  updatedAt: z.string(),
})
export type YoutubeEnvoi = z.infer<typeof youtubeEnvoiSchema>
