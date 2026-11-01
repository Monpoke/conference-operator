import { z } from 'zod'

/** A page opening edited videos: one talk, or the whole edition when `sessionId` is null. */
export const partageVideoSchema = z.object({
  id: z.string(),
  sessionId: z.string().nullable(),
  /** The talk's title, or `null` for the whole edition. */
  title: z.string().nullable(),
  url: z.string(),
  createdAt: z.string(),
})
export type PartageVideo = z.infer<typeof partageVideoSchema>

export const MOT_DE_PASSE_PARTAGE_MIN = 8

export const partageCreationSchema = z.object({
  sessionId: z.string().min(1).nullable(),
  motDePasse: z.string().min(MOT_DE_PASSE_PARTAGE_MIN).max(200),
})
export type PartageCreation = z.infer<typeof partageCreationSchema>
