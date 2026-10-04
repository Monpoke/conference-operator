/**
 * What the machine's environment says, before any hub answers.
 *
 * The room has **no execution mode of its own**: it takes the hub's (see
 * `RoomApp.mode()`), and stays in production as long as no hub has answered.
 * A room machine used to carry `MODE=dev` in its shortcut; plugged into the
 * event's hub, it then simulated OBS and accepted wiping its rushes while the
 * hub ran a real day — two machines disagreeing on what was at stake. Now the
 * hub alone says it, and a room cannot be more « dev » than its hub.
 *
 * What stays local is what only the machine can decide, for a development
 * bench: simulating OBS (`OBS_SIMULE=1`) — a real room plugged into the dev
 * hub must still drive its real OBS — and, on such a bench only, a simulated
 * local time to work with no hub (`HEURE_SIMULEE`).
 *
 * The default is the dangerous case, not the comfortable one: real OBS, real
 * time. The environment variable names are a frozen contract with the
 * machines' shortcuts.
 */
export interface RoomMode {
  /** OBS simulated rather than real instances: a development bench. */
  obsSimulated: boolean
  /** A simulated local time, to develop with no hub. Only with OBS simulated. */
  simulatedTime: string | null
  /**
   * The settings present in the environment and left without effect, with why.
   *
   * Neutralized noisily, and with their reason: a bare "ignored" would send one
   * looking in the wrong place.
   */
  ignores: IgnoredSetting[]
}

export interface IgnoredSetting {
  variable: string
  reason: string
}

/**
 * @param simulateObsByDefault The development script's default — it exists to
 *   run a room with no OBS; `OBS_REEL=1` then plugs it into real ones. The room
 *   application has no such default: `OBS_SIMULE=1`, said on purpose.
 */
export function readMode(env: NodeJS.ProcessEnv = process.env, simulateObsByDefault = false): RoomMode {
  const ignores: IgnoredSetting[] = []

  if ((env.MODE ?? '') !== '') {
    ignores.push({ variable: 'MODE', reason: 'le mode de la salle est hérité du hub (production tant qu\u2019il ne répond pas)' })
  }
  if (truthy(env.OBS_MOCK)) {
    ignores.push({ variable: 'OBS_MOCK', reason: 'remplacé par OBS_SIMULE=1' })
  }
  const obsSimulated = simulateObsByDefault ? env.OBS_REEL !== '1' : truthy(env.OBS_SIMULE)
  if (!obsSimulated && (env.HEURE_SIMULEE ?? '') !== '') {
    ignores.push({ variable: 'HEURE_SIMULEE', reason: 'réservé à un banc de développement (OBS_SIMULE=1)' })
  }

  return {
    obsSimulated,
    simulatedTime: obsSimulated ? (env.HEURE_SIMULEE ?? null) : null,
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
