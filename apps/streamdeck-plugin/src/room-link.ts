import type { DisplayPayload } from '@conference-operator/contract/room-display'
import { DEFAULT_BASE, normalizeBase } from './core/regie.js'
import { StateClient } from './core/state-client.js'

/**
 * The plugin's one link to the room machine, shared by every key.
 *
 * One state stream for the whole deck rather than one per key: thirty keys must
 * not open thirty streams on the machine that records the talk.
 */
export class RoomLink {
  private address = DEFAULT_BASE
  private readonly client: StateClient

  constructor(onChange: () => void) {
    this.client = new StateClient({ base: () => this.address, onState: onChange })
  }

  base(): string {
    return this.address
  }

  state(): DisplayPayload | null {
    return this.client.current()
  }

  /** The address set in the plugin's settings; an empty one goes back to the default. */
  setBase(value: string | undefined | null): void {
    const next = normalizeBase(value)
    if (next === this.address) return
    this.address = next
    this.client.restart()
  }

  start(): void {
    this.client.start()
  }
}
