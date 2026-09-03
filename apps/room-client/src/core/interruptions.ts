/**
 * Tracking a stream that reconnects.
 *
 * Two defects this small object fixes, both observed in the logs:
 *
 * 1. **We never learned that it came back.** Only the failures were traced.
 *    Faced with a stack of "retrying", nothing said whether the room had ended up
 *    reattaching — the information that decides whether one goes and looks at the
 *    network rack.
 * 2. **A long outage drowned out the rest.** The command stream retries every
 *    2 s: half an hour of unavailability wrote 900 identical lines, and the
 *    important message went under them.
 *
 * Hence the policy: the first failure is traced, the following ones are counted
 * and summarized at most once a minute, and the recovery is announced with the
 * real duration of the outage.
 */
export interface LoggedFailure {
  /** What has to be written, or `null` if the failure is merely counted. */
  message: string | null
  attempts: number
}

export class OutageTracker {
  private attempts = 0
  private startMs: number | null = null
  private lastLogMs = 0

  constructor(
    private readonly label: string,
    private readonly now: () => number = Date.now,
    /** Silence between two reminders during an outage that lasts. */
    private readonly reminderMs = 60_000,
  ) {}

  /** Declares a failure. Returns what should be written, if anything. */
  failure(): LoggedFailure {
    const now = this.now()
    this.attempts += 1
    if (this.startMs == null) this.startMs = now

    const first = this.attempts === 1
    if (first || now - this.lastLogMs >= this.reminderMs) {
      this.lastLogMs = now
      return {
        attempts: this.attempts,
        message: first
          ? `${this.label} interrompu, nouvelle tentative`
          : `${this.label} toujours interrompu — ${this.attempts} tentatives depuis ${formatDuration(now - this.startMs)}`,
      }
    }
    return { message: null, attempts: this.attempts }
  }

  /**
   * Declares the stream established.
   *
   * Returns `null` if nothing was broken: the first connection does not deserve
   * to be announced as a recovery.
   */
  restored(): { message: string; attempts: number } | null {
    if (this.startMs == null) return null
    const duration = this.now() - this.startMs
    const attempts = this.attempts
    this.attempts = 0
    this.startMs = null
    this.lastLogMs = 0
    return {
      attempts,
      message: `${this.label} rétabli après ${formatDuration(duration)} et ${attempts} tentative${attempts > 1 ? 's' : ''}`,
    }
  }
}

/** A short, readable duration: this is read in the control room, not in a report. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}
