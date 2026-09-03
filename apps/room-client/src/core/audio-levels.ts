import { DB_FLOOR, type InputLevel } from './obs.js'

/**
 * Brings the VU meter's rate down to something displayable.
 *
 * OBS emits some fifty measurements per second per input. Relaying them as they
 * come to every open page would undo all the work done so that an idle room
 * produces no traffic at all.
 *
 * **We aggregate by maximum, we do not sample.** Taking one measurement in five
 * would miss the peaks — precisely what one watches a VU meter to see. The
 * maximum over the interval keeps the briefest clipping.
 */
export class LevelAggregator {
  private accumulated = new Map<string, { magnitude: number; peak: number }[]>()
  private lastSentMs = 0

  constructor(
    private readonly emit: (inputs: InputLevel[]) => void,
    private readonly intervalMs = 100,
    private readonly now: () => number = Date.now,
  ) {}

  push(inputs: InputLevel[]): void {
    for (const input of inputs) {
      const current = this.accumulated.get(input.name)
      if (current == null) {
        this.accumulated.set(
          input.name,
          input.channels.map((channel) => ({ ...channel })),
        )
        continue
      }
      input.channels.forEach((channel, index) => {
        const target = current[index]
        if (target == null) {
          current[index] = { ...channel }
          return
        }
        target.magnitude = Math.max(target.magnitude, channel.magnitude)
        target.peak = Math.max(target.peak, channel.peak)
      })
    }

    const now = this.now()
    if (now - this.lastSentMs < this.intervalMs) return
    this.lastSentMs = now
    this.flush()
  }

  /** Sends what has been accumulated, then starts over from zero. */
  private flush(): void {
    if (this.accumulated.size === 0) return
    const inputs = [...this.accumulated.entries()].map(([name, channels]) => ({ name, channels }))
    this.accumulated.clear()
    this.emit(inputs)
  }

  /**
   * Declares silence.
   *
   * Called when OBS disconnects: without it, the last measurement would stay
   * displayed and a silent control room would show a signal.
   */
  reset(): void {
    this.accumulated.clear()
    this.lastSentMs = 0
  }
}

/** A level's position on a display scale, between 0 and 1. */
export function proportion(db: number): number {
  if (db <= DB_FLOOR) return 0
  return Math.min(1, (db - DB_FLOOR) / -DB_FLOOR)
}
