import type { Connectivity } from '@conference-operator/contract'

export interface ConnectivityProbeOptions {
  hubOrigin: string
  /** Injectable for the tests. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Tells "the hub cannot be reached" from "real time is broken".
 *
 * The two situations do not call for the same reaction in the control room:
 * network cut, we wait; hub reachable but the stream dead, we suspect the hub or
 * an intermediary cutting the WebSockets — and the operator must be told rather
 * than shown a misleading "offline".
 */
export async function probeConnectivity({
  hubOrigin,
  fetchImpl = fetch,
  timeoutMs = 3_000,
}: ConnectivityProbeOptions): Promise<Connectivity> {
  try {
    const response = await fetchImpl(new URL('/health', hubOrigin), {
      signal: AbortSignal.timeout(timeoutMs),
    })
    // The hub answers over HTTP but the real-time channel has gone down.
    return response.ok ? 'DEGRADED' : 'OFFLINE'
  } catch {
    return 'OFFLINE'
  }
}

export interface ConnectivityTrackerOptions extends ConnectivityProbeOptions {
  onChange: (connectivity: Connectivity) => void
}

/**
 * Tracks the connectivity state.
 *
 * We never trust `navigator.onLine`: it says whether a network card is active,
 * not whether our hub answers — which is the only question that matters in a
 * room.
 */
export class ConnectivityTracker {
  private current: Connectivity = 'OFFLINE'
  private probing = false

  constructor(private readonly options: ConnectivityTrackerOptions) {}

  get value(): Connectivity {
    return this.current
  }

  /** Real time works: nothing left to probe. */
  markOnline(): void {
    this.set('ONLINE')
  }

  /**
   * Real time has failed. Probes the hub over HTTP to decide between `DEGRADED`
   * and `OFFLINE`.
   */
  async markRealtimeFailure(): Promise<Connectivity> {
    if (this.probing) return this.current
    this.probing = true
    try {
      const probed = await probeConnectivity(this.options)
      this.set(probed)
      return probed
    } finally {
      this.probing = false
    }
  }

  private set(next: Connectivity): void {
    if (next === this.current) return
    this.current = next
    this.options.onChange(next)
  }
}
