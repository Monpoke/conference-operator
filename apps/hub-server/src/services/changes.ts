import { EventEmitter } from 'node:events'

const CHANNEL = 'change'

/**
 * How long a burst is left to settle before the watchers recompose.
 *
 * An ingest batch, the lifecycle decision it follows and the lock renewed in the
 * same instant are one change seen from a phone: recomposing the view three times
 * in a row would send three near-identical payloads down a mobile network.
 */
export const COALESCE_MS = 50

/**
 * "This room has changed", for whoever is watching it.
 *
 * Carries no data, on purpose: the watcher recomposes its view from what is
 * stored, exactly like `regie.view`. A payload here would be a second version of
 * the room's state, which would end up contradicting the first.
 *
 * The same in-process `EventEmitter` as `CommandService`, for the same reason:
 * the hub runs as a single instance, so every watcher lives in this process.
 */
export class RoomChanges {
  private readonly emitter = new EventEmitter()

  constructor(private readonly coalesceMs: number = COALESCE_MS) {
    // One listener per open mobile control app: the default limit of 10 is a
    // warning about a leak that is not one.
    this.emitter.setMaxListeners(0)
  }

  /** A room has changed; `null` for all of them — a program, the clock. */
  touch(roomId: string | null): void {
    this.emitter.emit(CHANNEL, roomId)
  }

  /**
   * One wake-up per settled burst, for one room.
   *
   * **Subscribed at call time**, not on the first `next()`: the caller reads the
   * view right after, and a change landing between the two would otherwise fall
   * into a gap nobody would notice.
   *
   * Touches arriving while a wake-up is pending are folded into it rather than
   * queued: the watcher reads the state once, and that read already includes them.
   */
  watch(roomId: string, signal?: AbortSignal): AsyncIterableIterator<void> {
    const emitter = this.emitter
    const coalesceMs = this.coalesceMs
    let dirty = false
    let wake: (() => void) | null = null
    // A function rather than a direct read: `aborted` changes across the awaits,
    // and TypeScript would otherwise freeze the value observed on entering the loop.
    const aborted = () => signal?.aborted === true

    const listener = (target: string | null) => {
      if (target != null && target !== roomId) return
      dirty = true
      wake?.()
    }
    const unsubscribe = () => {
      emitter.off(CHANNEL, listener)
      wake?.()
    }
    emitter.on(CHANNEL, listener)
    signal?.addEventListener('abort', unsubscribe, { once: true })

    return (async function* () {
      try {
        while (!aborted()) {
          if (!dirty) {
            await new Promise<void>((resolve) => {
              wake = resolve
            })
            wake = null
            continue
          }
          await new Promise((resolve) => setTimeout(resolve, coalesceMs))
          if (aborted()) return
          dirty = false
          yield
        }
      } finally {
        signal?.removeEventListener('abort', unsubscribe)
        emitter.off(CHANNEL, listener)
      }
    })()
  }
}
