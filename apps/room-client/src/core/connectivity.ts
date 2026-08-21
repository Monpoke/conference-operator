import type { Connectivity } from '@cloudnord/contract'

export interface ConnectivityProbeOptions {
  hubOrigin: string
  /** Injectable pour les tests. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Distingue « le hub est injoignable » de « le temps réel est cassé ».
 *
 * Les deux situations n'appellent pas la même réaction en régie : réseau coupé,
 * on attend ; hub joignable mais flux mort, on soupçonne le hub ou un
 * intermédiaire qui coupe les WebSockets — et il faut le dire à l'opérateur
 * plutôt que de lui montrer un « hors ligne » trompeur.
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
    // Le hub répond en HTTP mais le canal temps réel est tombé.
    return response.ok ? 'DEGRADED' : 'OFFLINE'
  } catch {
    return 'OFFLINE'
  }
}

export interface ConnectivityTrackerOptions extends ConnectivityProbeOptions {
  onChange: (connectivity: Connectivity) => void
}

/**
 * Suit l'état de connectivité.
 *
 * On ne se fie jamais à `navigator.onLine` : il dit si une carte réseau est
 * active, pas si notre hub répond — ce qui est la seule question qui compte en salle.
 */
export class ConnectivityTracker {
  private current: Connectivity = 'OFFLINE'
  private probing = false

  constructor(private readonly options: ConnectivityTrackerOptions) {}

  get value(): Connectivity {
    return this.current
  }

  /** Le temps réel fonctionne : plus rien à sonder. */
  markOnline(): void {
    this.set('ONLINE')
  }

  /**
   * Le temps réel a échoué. Sonde le hub en HTTP pour trancher entre
   * `DEGRADED` et `OFFLINE`.
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
