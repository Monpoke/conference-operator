import OBSWebSocket from 'obs-websocket-js'
import type { ObsTransport } from './obs.js'

/**
 * An adapter from `obs-websocket-js` v5 to our reduced interface.
 *
 * All the rest of the code only knows `ObsTransport`, which makes it possible to
 * test the role and reconnection logic with no OBS instance.
 */
export function createObsTransport(): ObsTransport {
  const obs = new OBSWebSocket()

  return {
    async connect(url, password, subscriptions) {
      await obs.connect(url, password, { eventSubscriptions: subscriptions })
    },
    async reidentify(subscriptions) {
      // Renegotiates without reopening: the connection, the scenes and the
      // current state are kept, only the volume of events changes.
      await obs.reidentify({ eventSubscriptions: subscriptions })
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
 * Reconnecting to OBS in a loop.
 *
 * OBS can be started after the control app, or restarted during the day: not
 * retrying would force the operator to relaunch the application during the event.
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
