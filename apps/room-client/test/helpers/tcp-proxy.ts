import { createServer, connect, type Server, type Socket } from 'node:net'

/**
 * Proxy TCP débranchable.
 *
 * Permet de couper le réseau entre la salle et le hub pour de vrai — sockets
 * tranchés, connexions refusées — plutôt que de simuler une panne en trichant
 * sur le client. C'est la seule façon de vérifier que la reconnexion et la
 * remontée différée fonctionnent réellement.
 */
export class ToggleProxy {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private branche = true
  private port = 0

  constructor(
    private readonly targetPort: number,
    private readonly targetHost = '127.0.0.1',
  ) {}

  async listen(): Promise<number> {
    this.server = createServer((client) => {
      if (!this.branche) {
        client.destroy()
        return
      }
      const amont = connect(this.targetPort, this.targetHost)
      this.sockets.add(client)
      this.sockets.add(amont)

      client.pipe(amont)
      amont.pipe(client)

      const fermer = (): void => {
        this.sockets.delete(client)
        this.sockets.delete(amont)
        client.destroy()
        amont.destroy()
      }
      for (const socket of [client, amont]) {
        socket.on('error', fermer)
        socket.on('close', fermer)
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

  /** Coupe le câble : sockets existants tranchés, nouvelles connexions refusées. */
  debrancher(): void {
    this.branche = false
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  rebrancher(): void {
    this.branche = true
  }

  async close(): Promise<void> {
    this.debrancher()
    await new Promise<void>((resolve) => {
      if (this.server == null) return resolve()
      this.server.close(() => resolve())
    })
  }
}
