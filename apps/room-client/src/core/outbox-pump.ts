import type { Connectivity, DisplayMode, Envelope, RoomEventPayload, SceneRole } from '@cloudnord/contract'
import { heartbeatDedupKey, type Outbox } from './outbox.js'

// Re-exported here: it is the pump that uses it when emitting.
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
  /** Sending up to the hub. Injected to test the drain with no network. */
  push: (batch: Envelope[]) => Promise<PushResult>
  onConnectivity?: (connectivity: Connectivity) => void
  onDepth?: (depth: number) => void
  /** The clock offset measured on every successful send. */
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
 * Drains the queue towards the hub.
 *
 * One batch in flight at a time, in `seq` order: the hub applies in that order,
 * and an out-of-order send would skew the room's history.
 */
export class OutboxPump {
  private timer: NodeJS.Timeout | null = null
  private draining = false
  /**
   * The pump has been stopped, and a batch may still be in flight.
   *
   * Distinct from `timer == null`: what matters is not that there is no tick any
   * more, but that a drain that left **before** the stop does not come back and
   * write after it. See `drainOnce`.
   */
  private stopped = false
  private connectivity: Connectivity = 'OFFLINE'

  constructor(private readonly options: OutboxPumpOptions) {}

  private setConnectivity(next: Connectivity): void {
    if (next === this.connectivity) return
    this.connectivity = next
    this.options.onConnectivity?.(next)
  }

  /**
   * One drain pass.
   *
   * Never throws: a network failure is a normal state, not an exception. The
   * batch is deferred with backoff and the connectivity switches.
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
      if (this.stopped) return this.abandon(batch.length)

      // The acknowledged and the duplicates leave alike: in both cases the hub
      // holds them. That is what makes the replay harmless after a reconnection.
      outbox.ack([...result.acked, ...result.duplicates])
      outbox.reject(result.rejected)

      const handled = new Set([
        ...result.acked,
        ...result.duplicates,
        ...result.rejected.map((entry) => entry.id),
      ])
      // An event the hub neither acknowledged nor rejected will be picked up later.
      const remaining = batch.filter((envelope) => !handled.has(envelope.id))
      outbox.defer(remaining.map((envelope) => envelope.id))

      if (result.serverTime != null) this.options.onServerTime?.(result.serverTime)
      this.setConnectivity('ONLINE')
      this.options.onDepth?.(outbox.backlog())

      return {
        sent: result.acked.length,
        duplicates: result.duplicates.length,
        rejected: result.rejected.length,
        deferred: remaining.length,
        connectivity: 'ONLINE',
      }
    } catch (cause) {
      if (this.stopped) return this.abandon(batch.length)
      outbox.defer(batch.map((envelope) => envelope.id))
      this.setConnectivity('OFFLINE')
      this.options.store.log('warn', 'remontée impossible, lot reporté', {
        size: batch.length,
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

  /**
   * The batch comes back after the stop: we touch nothing any more.
   *
   * The database is closed — or about to be — and the write would fail inside the
   * `catch` that exists precisely to catch failures, hence an unhandled rejection
   * that made it all the way up to the process.
   *
   * **Nothing is lost.** `claimBatch` does not mark what it reads: it returns
   * whatever is due. A batch we give up deferring therefore stays eligible as it
   * is, and leaves on the first pass of the next opening — which is exactly the
   * intended behaviour after a restart.
   */
  private abandon(size: number): DrainOutcome {
    return {
      sent: 0,
      duplicates: 0,
      rejected: 0,
      deferred: size,
      connectivity: this.connectivity,
    }
  }

  /**
   * One pass, at most one at a time.
   *
   * The guard protects the `seq` order: without it, a slow network would send two
   * batches in parallel and the hub would apply them out of order. It holds for
   * the tick **and** for the wake-up — it is precisely when the two cross that it
   * counts.
   */
  private pass(): void {
    if (this.draining) return
    this.draining = true
    void this.drainOnce().finally(() => {
      this.draining = false
    })
  }

  /**
   * Drains the queue now, without waiting for the tick.
   *
   * For what is watched from afar. A mobile control app never paints ahead — a
   * button describes OBS, not what it was asked for — so the gesture stays without
   * visible effect until the room has sent up what changed. Two seconds of tick
   * plus one second of polling, and one presses a second time believing one missed
   * the button.
   *
   * Called on OBS's changes, not on every send: it is one fact per switch, not a
   * flow. The self-sufficiency invariant holds — nothing here blocks, and an
   * absent network simply leaves the batch in the queue.
   *
   * **Without effect while the pump is not running**, and the guard is not
   * cosmetic: OBS keeps emitting while the application shuts down, and a drain
   * started after the database is closed fails inside its own `catch` — which
   * itself writes to the database to defer the batch. The wake-up only makes sense
   * between `start()` and `stop()`; outside them, there is no tick left to get
   * ahead of.
   */
  wake(): void {
    if (this.timer == null) return
    this.pass()
  }

  start(): void {
    if (this.timer != null) return
    this.stopped = false
    const interval = this.options.intervalMs ?? 2_000
    this.timer = setInterval(() => this.pass(), interval)
    // Does not hold the process: the application must be able to close.
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
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
  /** What the room screen displays: it only comes up through the heartbeat. */
  displayMode: DisplayMode
}

export function buildHeartbeat(input: HeartbeatInput): RoomEventPayload {
  return { type: 'room.heartbeat', ...input }
}
