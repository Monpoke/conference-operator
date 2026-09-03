/**
 * The hub's clock.
 *
 * A single source of time for everything dated on the server side: sync time,
 * command issuing, decisions about talks, automatic closing. The rooms align on
 * it through the offset they measure at every `sync` — so simulating here is
 * enough to move the whole system.
 *
 * That is what was missing: a clock simulated on the room side alone diverges
 * from the hub's, and everything that compares the two — a command's staleness,
 * for instance — starts to lie.
 */
export interface Clock {
  now(): number
  nowIso(): string
  /** True when the time is simulated: to be flagged, or nobody will understand. */
  readonly simulated: boolean
}

export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    simulated: false,
  }
}

/**
 * A clock shifted to a given instant, which then advances at real speed.
 *
 * Advancing rather than freezing is deliberate: a frozen countdown is
 * indistinguishable from a crashed screen, and automatic closing would never
 * fire.
 */
export function simulatedClock(target: string, base: () => number = Date.now): Clock {
  const targetMs = Date.parse(target)
  if (Number.isNaN(targetMs)) {
    throw new Error(`Heure simulée illisible : ${target}`)
  }
  const start = base()
  const now = (): number => targetMs + (base() - start)

  return {
    now,
    nowIso: () => new Date(now()).toISOString(),
    simulated: true,
  }
}

/**
 * A clock that can be set at runtime.
 *
 * Lets the whole system be moved from the console, without restarting the hub.
 * Every change must be followed by a broadcast to the rooms: they align their
 * offset on `serverTime` and would otherwise stay on the old time until their
 * next synchronization.
 */
export interface MutableClock extends Clock {
  /** `null` goes back to real time. */
  setSimulated(target: string | null): void
}

export function mutableClock(initial: string | null = null): MutableClock {
  let inner: Clock = initial == null ? systemClock() : simulatedClock(initial)

  return {
    now: () => inner.now(),
    nowIso: () => inner.nowIso(),
    get simulated() {
      return inner.simulated
    },
    setSimulated(target) {
      // Validation before replacement: an unreadable time must not leave the hub
      // without a clock.
      inner = target == null ? systemClock() : simulatedClock(target)
    },
  }
}
