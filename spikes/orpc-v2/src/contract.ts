import { eventIterator, oc } from '@orpc/contract'
import { z } from 'zod'

/**
 * Contrat réduit, représentatif des trois usages réels du projet :
 *  - un appel simple (health.ping)
 *  - un batch idempotent montant (ingest.push  ← outbox)
 *  - un flux descendant reprenable (rooms.commands ← inbox)
 */

export const commandSchema = z.object({
  seq: z.number().int().positive(),
  type: z.string(),
  payload: z.string(),
})
export type Command = z.infer<typeof commandSchema>

export const envelopeSchema = z.object({
  id: z.string(),
  type: z.string(),
})

export const contract = {
  health: {
    ping: oc
      .input(z.object({ from: z.string() }))
      .output(z.object({ pong: z.string(), transport: z.string() })),
  },
  ingest: {
    push: oc
      .input(z.object({ roomId: z.string(), batch: z.array(envelopeSchema) }))
      .output(z.object({ acked: z.array(z.string()), duplicates: z.array(z.string()) })),
  },
  rooms: {
    commands: oc
      .input(z.object({ roomId: z.string() }))
      .output(eventIterator(commandSchema)),
  },
}
