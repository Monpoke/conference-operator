import { z } from 'zod'

/** The link to the channel. The client's secret and the channel's token never come back. */
export const youtubeStatusSchema = z.object({
  clientId: z.string().nullable(),
  hasSecret: z.boolean(),
  connected: z.boolean(),
  channel: z.string().nullable(),
  /** To declare in the Google project, as an authorised redirect address. */
  redirectUri: z.string(),
})
export type YoutubeStatus = z.infer<typeof youtubeStatusSchema>

export const youtubeEnvoiStateSchema = z.enum(['attente', 'en-cours', 'termine', 'echoue'])

export const youtubeEnvoiSchema = z.object({
  jobId: z.string(),
  state: youtubeEnvoiStateSchema,
  videoId: z.string().nullable(),
  octets: z.number().int().nonnegative(),
  taille: z.number().int().nullable(),
  erreur: z.string().nullable(),
  updatedAt: z.string(),
})
export type YoutubeEnvoi = z.infer<typeof youtubeEnvoiSchema>
