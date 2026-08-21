import type { Connectivity, Envelope, RoomEventPayload, SceneRole } from '@cloudnord/contract'
import { heartbeatDedupKey, type Outbox } from './outbox.js'

// Réexportée ici : c'est la pompe qui l'utilise à l'émission.
export { heartbeatDedupKey }
import type { LocalStore } from './store.js'

export interface PushResult {
  acked: string[]
  duplicates: string[]
  rejected: { id: string; reason: string }[]
  serverTime?: string
}

export interface OutboxPumpOptions {
  outbox: Outbox
  store: LocalStore
  /** Remontée vers le hub. Injectée pour tester la vidange sans réseau. */
  push: (batch: Envelope[]) => Promise<PushResult>
  onConnectivity?: (connectivity: Connectivity) => void
  onDepth?: (depth: number) => void
  /** Décalage d'horloge mesuré à chaque remontée réussie. */
  onServerTime?: (serverTime: string) => void
  batchSize?: number
  intervalMs?: number
  now?: () => number
}

export interface DrainOutcome {
  sent: number
  duplicates: number
  rejected: number
  deferred: number
  connectivity: Connectivity
}

/**
 * Vidange la file vers le hub.
 *
 * Un seul lot en vol à la fois, dans l'ordre des `seq` : le hub applique dans
 * cet ordre, et une remontée désordonnée fausserait l'historique de la salle.
 */
export class OutboxPump {
  private timer: NodeJS.Timeout | null = null
  private draining = false
  private connectivity: Connectivity = 'OFFLINE'

  constructor(private readonly options: OutboxPumpOptions) {}

  private setConnectivity(next: Connectivity): void {
    if (next === this.connectivity) return
    this.connectivity = next
    this.options.onConnectivity?.(next)
  }

  /**
   * Une passe de vidange.
   *
   * Ne lève jamais : l'échec réseau est un état normal, pas une exception. Le
   * lot est reporté avec backoff et la connectivité bascule.
   */
  async drainOnce(): Promise<DrainOutcome> {
    const { outbox, push } = this.options
    outbox.evictExpired()

    const batch = outbox.claimBatch(this.options.batchSize ?? 100)
    this.options.onDepth?.(outbox.backlog())

    if (batch.length === 0) {
      return { sent: 0, duplicates: 0, rejected: 0, deferred: 0, connectivity: this.connectivity }
    }

    try {
      const result = await push(batch)

      // Acquittés et doublons sortent pareillement : dans les deux cas le hub
      // les détient. C'est ce qui rend le rejeu inoffensif après reconnexion.
      outbox.ack([...result.acked, ...result.duplicates])
      outbox.reject(result.rejected)

      const traites = new Set([
        ...result.acked,
        ...result.duplicates,
        ...result.rejected.map((entry) => entry.id),
      ])
      // Un événement que le hub n'a ni acquitté ni rejeté sera repris plus tard.
      const restants = batch.filter((envelope) => !traites.has(envelope.id))
      outbox.defer(restants.map((envelope) => envelope.id))

      if (result.serverTime != null) this.options.onServerTime?.(result.serverTime)
      this.setConnectivity('ONLINE')
      this.options.onDepth?.(outbox.backlog())

      return {
        sent: result.acked.length,
        duplicates: result.duplicates.length,
        rejected: result.rejected.length,
        deferred: restants.length,
        connectivity: 'ONLINE',
      }
    } catch (cause) {
      outbox.defer(batch.map((envelope) => envelope.id))
      this.setConnectivity('OFFLINE')
      this.options.store.log('warn', 'remontée impossible, lot reporté', {
        taille: batch.length,
        message: (cause as Error).message,
      })
      return {
        sent: 0,
        duplicates: 0,
        rejected: 0,
        deferred: batch.length,
        connectivity: 'OFFLINE',
      }
    }
  }

  start(): void {
    if (this.timer != null) return
    const interval = this.options.intervalMs ?? 2_000
    this.timer = setInterval(() => {
      // Un seul passage à la fois : sans ce garde, un réseau lent ferait
      // partir deux lots en parallèle et casserait l'ordre des `seq`.
      if (this.draining) return
      this.draining = true
      void this.drainOnce().finally(() => {
        this.draining = false
      })
    }, interval)
    // Ne retient pas le process : l'application doit pouvoir se fermer.
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer)
    this.timer = null
  }
}



export interface HeartbeatInput {
  connectivity: Connectivity
  sceneRole: SceneRole | null
  recording: boolean
  streaming: boolean
  outboxDepth: number
  programContentHash: string | null
}

export function buildHeartbeat(input: HeartbeatInput): RoomEventPayload {
  return { type: 'room.heartbeat', ...input }
}
