import { z } from 'zod'

/**
 * The edition's figures, for the console's statistics page.
 *
 * One row per talk rather than totals: the page filters by room and by day, and
 * every average has to be worked out again on what remains.
 */
export const statistiqueTalkSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  roomId: z.string().nullable(),
  roomName: z.string().nullable(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  /** Late at the start. `null`: never started, or started by the time rule rather than by somebody. */
  retardMs: z.number().int().nullable(),
  /** Past its slot at the end, negative when early. `null`: no end known. */
  depassementMs: z.number().int().nullable(),
  /** Started or ended by the time rule: its hours say nothing of the room. */
  auto: z.boolean(),
  tenue: z.boolean(),
  sansCaptation: z.boolean(),
  rush: z.enum(['rentre', 'en-cours', 'echec', 'manquant', 'sans-objet']),
  rushOctets: z.number().int().nonnegative(),
  /** The room's measures on the kept cut. `null`: not analysed. */
  lufs: z.number().nullable(),
  truePeak: z.number().nullable(),
  lra: z.number().nullable(),
  confiance: z.string().nullable(),
  alertesSaturation: z.number().int().nonnegative(),
  alertesSilence: z.number().int().nonnegative(),
  /** Its takes' states, oldest take first. */
  montages: z.array(z.string()),
  videoMs: z.number().int().nonnegative(),
  consentement: z.string().nullable(),
})
export type StatistiqueTalk = z.infer<typeof statistiqueTalkSchema>

export const statistiquesSchema = z.object({
  talks: z.array(statistiqueTalkSchema),
  sponsors: z.object({
    total: z.number().int().nonnegative(),
    paliers: z.array(z.object({ nom: z.string(), nombre: z.number().int().nonnegative() })),
  }),
  exploitation: z.object({
    actions: z.number().int().nonnegative(),
    refusees: z.number().int().nonnegative(),
  }),
  questions: z.number().int().nonnegative(),
  timezone: z.string(),
})
export type Statistiques = z.infer<typeof statistiquesSchema>

/** What a room reported going wrong, newest first. */
export const roomIncidentSchema = z.object({
  roomId: z.string(),
  occurredAt: z.string(),
  niveau: z.enum(['warn', 'error']),
  source: z.string(),
  message: z.string(),
  fichier: z.string().nullable(),
  detail: z.string().nullable(),
})
export type RoomIncident = z.infer<typeof roomIncidentSchema>
