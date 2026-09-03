import type { ExecutionMode } from '@cloudnord/contract'

/**
 * The room's execution mode.
 *
 * A single switch in front of the development conveniences, instead of one
 * variable per convenience. Two reasons, and the second counts more than the
 * first.
 *
 * 1. On the day, what has to be checked fits on one line.
 * 2. The development settings apply **only** in this mode. An `OBS_MOCK=1`
 *    forgotten in a shortcut is a whole day filmed by an OBS instance that does
 *    not exist — the failure is discovered at editing time, when there is nothing
 *    left to catch up.
 *
 * The default is `production`: the default must be the dangerous case, not the
 * comfortable one.
 *
 * The environment variable names (`MODE`, `OBS_MOCK`, `OBS_REEL`,
 * `HEURE_SIMULEE`) are a frozen contract with the machines' shortcuts.
 */
export interface RoomMode {
  mode: ExecutionMode
  /** OBS simulated rather than two real instances. */
  obsSimulated: boolean
  /** A simulated local time, to develop with no hub. */
  simulatedTime: string | null
  /**
   * The settings present in the environment and left without effect, with why.
   *
   * Neutralized noisily, and with their reason: a bare "ignored" would send one
   * looking in the wrong place, and the two causes — reserved for development, or
   * gone — are not fixed the same way.
   */
  ignores: IgnoredSetting[]
}

export interface IgnoredSetting {
  variable: string
  reason: string
}

export function readMode(env: NodeJS.ProcessEnv = process.env): RoomMode {
  const dev = env.MODE === 'dev'
  const ignores: IgnoredSetting[] = []

  // Obsolete in both modes: in development, OBS is simulated by default. Finding
  // it in a shortcut means someone is counting on it.
  if (truthy(env.OBS_MOCK)) {
    ignores.push({
      variable: 'OBS_MOCK',
      reason: 'remplacé par MODE=dev, qui simule OBS par défaut (OBS_REEL=1 pour de vraies instances)',
    })
  }
  if (!dev && (env.HEURE_SIMULEE ?? '') !== '') {
    ignores.push({ variable: 'HEURE_SIMULEE', reason: 'réservé au mode développement (MODE=dev)' })
  }

  return {
    mode: dev ? 'dev' : 'production',
    // Simulated by default in development: it is the common case, and demanding
    // one more variable for the common case is paid for in oversights. `OBS_REEL`
    // is never reported in production: without effect, but what it asks for is
    // precisely what happens, and warning would sow doubt.
    obsSimulated: dev && env.OBS_REEL !== '1',
    simulatedTime: dev ? (env.HEURE_SIMULEE ?? null) : null,
    ignores,
  }
}

/** The shapes one writes in a `.env` to say "yes". */
function truthy(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

/**
 * The room's simulated time, expressed as an **offset** on the machine clock.
 *
 * An offset, and above all not a replacement clock. All the rest of the client
 * counts from `Date.now()` — the served pages, which only have access to the
 * browser's clock, and the outbox, which dates its events. Replacing the clock of
 * the application core alone made them diverge silently: the hub said 4 pm, the
 * pages showed 4 pm, and the control app looked for its talks several weeks
 * further on.
 *
 * As an offset, the time always moves at the real pace — a frozen countdown is
 * indistinguishable from a hung screen — and the hub's time simply takes over at
 * the first synchronization, by replacing the value.
 */
export function modeOffset(mode: RoomMode, base: () => number = Date.now): number {
  if (mode.simulatedTime == null) return 0
  const target = Date.parse(mode.simulatedTime)
  if (Number.isNaN(target)) throw new Error(`HEURE_SIMULEE illisible : ${mode.simulatedTime}`)
  return target - base()
}
