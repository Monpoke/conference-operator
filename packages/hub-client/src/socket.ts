import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import type { ContractRouterClient } from '@orpc/contract'
import type { ControlView, contract } from '@conference-operator/contract'
import type { HubClient } from './client.js'

/**
 * The hub over a WebSocket, from a browser.
 *
 * A browser cannot set a header on a WebSocket: the socket is opened with a
 * one-shot ticket instead, asked for over HTTP where the token and the tab's
 * session do travel as headers.
 *
 * **No reconnection here**, on purpose. A ticket opens one socket and one only, so
 * reopening needs a fresh ticket — which only the caller can ask for. oRPC's own
 * reconnection would retry on a dead ticket forever.
 */
export interface HubSocket {
  rpc: ContractRouterClient<typeof contract>
  close(): void
}

export function openHubSocket(options: { ticket: string; origin?: string }): HubSocket {
  const origin = options.origin ?? globalThis.location.origin
  const url = `${origin.replace(/^http/, 'ws')}/ws?ticket=${encodeURIComponent(options.ticket)}`
  let socket: WebSocket | null = null

  const rpc: ContractRouterClient<typeof contract> = createORPCClient(
    new RPCLink({
      connect: () => {
        socket = new WebSocket(url)
        return socket
      },
      reconnect: { enabled: false },
    }),
  )

  return {
    rpc,
    close: () => socket?.close(),
  }
}

/**
 * A room's control view, pushed, for as long as the socket lives.
 *
 * Ticket, socket, stream — and the socket closed however the stream ends. Ends or
 * throws when the connection does; reopening is the caller's decision, and so is
 * what to show in the meantime.
 *
 * Yields `null` for the hub's "nothing new": the stream is alive, the last view
 * still holds. The hub only sends a view when it differs from the previous one.
 */
export async function* watchControlRoom(
  client: HubClient,
  roomId: string,
  signal: AbortSignal,
  origin?: string,
): AsyncGenerator<ControlView | null> {
  const { ticket } = await client.rpc.regie.ticket()
  const socket = openHubSocket({ ticket, origin })
  try {
    const stream = await socket.rpc.regie.watch({ roomId }, { signal })
    for await (const event of stream) yield 'unchanged' in event ? null : event
  } finally {
    socket.close()
  }
}
