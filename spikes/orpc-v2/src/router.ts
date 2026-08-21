import { implement } from '@orpc/server'
import { withEventMeta } from '@orpc/server'
import { contract } from './contract.js'

const os = implement(contract)

/** Journal des événements déjà ingérés, pour prouver l'idempotence. */
const ingested = new Set<string>()

/** Commandes disponibles côté hub, identifiées par un `seq` monotone. */
export const commandLog = [
  { seq: 1, type: 'scene.force', payload: 'HOLD' },
  { seq: 2, type: 'wall.approved', payload: 'Bonjour Cloud Nord' },
  { seq: 3, type: 'scene.force', payload: 'LIVE' },
  { seq: 4, type: 'message.broadcast', payload: 'Pause déjeuner' },
  { seq: 5, type: 'scene.force', payload: 'HOLD' },
]

export function makeRouter(transport: string) {
  return os.router({
    health: {
      ping: os.health.ping.handler(({ input }) => ({
        pong: `hello ${input.from}`,
        transport,
      })),
    },
    ingest: {
      push: os.ingest.push.handler(({ input }) => {
        const acked: string[] = []
        const duplicates: string[] = []
        for (const envelope of input.batch) {
          const key = `${input.roomId}:${envelope.id}`
          if (ingested.has(key)) duplicates.push(envelope.id)
          else {
            ingested.add(key)
            acked.push(envelope.id)
          }
        }
        return { acked, duplicates }
      }),
    },
    rooms: {
      // `lastEventId` est fourni par oRPC à la reprise du flux : c'est lui qui
      // porte le rattrapage, pas un paramètre d'entrée maison.
      commands: os.rooms.commands.handler(async function* ({ lastEventId, signal }) {
        const from = lastEventId != null ? Number(lastEventId) : 0
        for (const command of commandLog) {
          if (command.seq <= from) continue
          if (signal?.aborted) return
          // L'id d'événement porte le `seq` : c'est ce que le client renverra.
          yield withEventMeta(command, { id: String(command.seq) })
          await new Promise((resolve) => setTimeout(resolve, 30))
        }
      }),
    },
  })
}

export function resetIngestLog(): void {
  ingested.clear()
}
