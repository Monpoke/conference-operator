import OBSWebSocket from 'obs-websocket-js'
import type { ObsTransport } from './obs.js'

/**
 * Adaptateur `obs-websocket-js` v5 vers notre interface réduite.
 *
 * Tout le reste du code ne connaît que `ObsTransport`, ce qui permet de tester
 * la logique de rôles et de reconnexion sans instance OBS.
 */
export function createObsTransport(): ObsTransport {
  const obs = new OBSWebSocket()

  return {
    async connect(url, password, abonnements) {
      await obs.connect(url, password, { eventSubscriptions: abonnements })
    },
    async reidentify(abonnements) {
      // Renégocie sans rouvrir : la connexion, les scènes et l'état en cours
      // sont conservés, seul le volume d'événements change.
      await obs.reidentify({ eventSubscriptions: abonnements })
    },
    async disconnect() {
      await obs.disconnect()
    },
    call: (async (request: string, args?: Record<string, unknown>) =>
      obs.call(request as never, args as never)) as ObsTransport['call'],
    on(event, handler) {
      obs.on(event as never, handler as never)
    },
    off(event, handler) {
      obs.off(event as never, handler as never)
    },
  }
}

export interface ReconnectingObsOptions {
  connect: () => Promise<unknown>
  onLog?: (level: 'info' | 'warn', message: string, context?: unknown) => void
  delayMs?: number
  signal?: AbortSignal
}

/**
 * Reconnexion à OBS en boucle.
 *
 * OBS peut être lancé après la régie, ou redémarré en cours de journée : ne pas
 * réessayer obligerait l'opérateur à relancer l'application pendant l'événement.
 */
export async function keepObsConnected({
  connect,
  onLog,
  delayMs = 3_000,
  signal,
}: ReconnectingObsOptions): Promise<void> {
  const aborted = () => signal?.aborted === true

  while (!aborted()) {
    try {
      await connect()
      return
    } catch (cause) {
      onLog?.('warn', 'OBS injoignable, nouvelle tentative', {
        message: (cause as Error).message,
      })
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}
