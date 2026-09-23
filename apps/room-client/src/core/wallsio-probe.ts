/**
 * Does walls.io answer?
 *
 * The one scene of the loop that needs the Internet. Checked here, by the room's
 * server, rather than by the page: a page probing a third-party origin would be
 * the only request the projector makes outside the machine, and it could not
 * read the answer anyway. The page receives a boolean and skips the scene while
 * it is false — an embed stuck on "cannot reach this page" in front of the room
 * reads as a breakdown.
 */
export interface WallsIoProbeOptions {
  /** The embed address, read back on every check: it changes at sync. */
  url: () => string | null
  onChange: () => void
  fetchImpl?: typeof fetch
  intervalMs?: number
  timeoutMs?: number
}

export class WallsIoProbe {
  /** Optimistic until the first answer: the page loads the wall off screen anyway. */
  reachable = true
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: WallsIoProbeOptions) {}

  start(): void {
    if (this.timer != null) return
    void this.check()
    this.timer = setInterval(() => void this.check(), this.options.intervalMs ?? 60_000)
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer)
    this.timer = null
  }

  /** Any HTTP answer counts: it is the route that is tested, not the wall. */
  async check(): Promise<boolean> {
    const url = this.options.url()
    let reachable = false
    if (url != null) {
      try {
        await (this.options.fetchImpl ?? fetch)(new URL(url).origin, {
          method: 'HEAD',
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 6_000),
        })
        reachable = true
      } catch {
        reachable = false
      }
    }
    if (reachable !== this.reachable) {
      this.reachable = reachable
      this.options.onChange()
    }
    return reachable
  }
}
