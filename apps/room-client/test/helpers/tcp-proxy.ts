import { createServer, connect, type Server, type Socket } from 'node:net'

/**
 * An unpluggable TCP proxy.
 *
 * Makes it possible to cut the network between the room and the hub for real —
 * sockets severed, connections refused — rather than simulate a failure by
 * cheating on the client. It is the only way to check that the reconnection and
 * the deferred sending really work.
 */
export class ToggleProxy {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private pluggedIn = true
  private port = 0

  constructor(
    private readonly targetPort: number,
    private readonly targetHost = '127.0.0.1',
  ) {}

  async listen(): Promise<number> {
    this.server = createServer((client) => {
      if (!this.pluggedIn) {
        client.destroy()
        return
      }
      const upstream = connect(this.targetPort, this.targetHost)
      this.sockets.add(client)
      this.sockets.add(upstream)

      client.pipe(upstream)
      upstream.pipe(client)

      const close = (): void => {
        this.sockets.delete(client)
        this.sockets.delete(upstream)
        client.destroy()
        upstream.destroy()
      }
      for (const socket of [client, upstream]) {
        socket.on('error', close)
        socket.on('close', close)
      }
    })

    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const address = this.server!.address()
    this.port = typeof address === 'object' && address != null ? address.port : 0
    return this.port
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /** Cuts the cable: existing sockets severed, new connections refused. */
  unplug(): void {
    this.pluggedIn = false
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  plug(): void {
    this.pluggedIn = true
  }

  async close(): Promise<void> {
    this.unplug()
    await new Promise<void>((resolve) => {
      if (this.server == null) return resolve()
      this.server.close(() => resolve())
    })
  }
}
